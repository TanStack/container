#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include "mbedtls/platform.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/ssl.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "mbedtls/pem.h"
#include "mbedtls/error.h"
#include "psa/crypto.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(int, tls_entropy, (unsigned char *output, size_t length), {
    try {
        for(let offset=0;offset<length;offset+=65536)
            globalThis.crypto.getRandomValues(HEAPU8.subarray(output+offset,output+Math.min(length,offset+65536)));
        return 0;
    } catch (_) { return -1; }
});
#else
static int tls_entropy(unsigned char *output,size_t length) { arc4random_buf(output,length);return 0; }
#endif

/* One instance belongs to one process. PSA state and allocator hooks never
 * cross owner instances. No guest-visible pointer is used as a connection ID. */
#define TLS_CAPACITY 65536
#define TLS_MAX_CONNECTIONS 32
#define TLS_MAX_PEM 1048576
typedef union { max_align_t alignment; size_t size; } Allocation;
static size_t allocated,peak,limit,allocation_failures;
static int initialized,max_connections,next_id=1;
static void *allocate(size_t count,size_t size) {
    if(size&&count>(SIZE_MAX-sizeof(Allocation))/size){allocation_failures++;return NULL;}
    size_t bytes=count*size+sizeof(Allocation);
    if(bytes>limit||allocated>limit-bytes){allocation_failures++;return NULL;}
    Allocation *block=calloc(1,bytes);
    if(!block){allocation_failures++;return NULL;}
    block->size=bytes;allocated+=bytes;if(allocated>peak)peak=allocated;
    return block+1;
}
static void deallocate(void *pointer) {
    if(!pointer)return;
    Allocation *block=(Allocation *)pointer-1;
    size_t size=block->size;
    if(size>allocated)abort();
    allocated-=size;mbedtls_platform_zeroize(block,size);free(block);
}
int mbedtls_hardware_poll(void *context,unsigned char *output,size_t length,size_t *written) {
    (void)context;*written=0;if(tls_entropy(output,length))return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
    *written=length;return 0;
}
typedef struct { unsigned char data[TLS_CAPACITY];size_t start,length; } Queue;
typedef struct {
    int id,failed,closed;
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config config;
    mbedtls_ctr_drbg_context rng;
    mbedtls_entropy_context entropy;
    mbedtls_x509_crt ca,certificate;
    mbedtls_pk_context key;
    Queue input,output;
} Connection;
static Connection *connections[TLS_MAX_CONNECTIONS];
static Connection *find(int id) {
    if(id<=0)return NULL;
    for(int i=0;i<max_connections;i++)if(connections[i]&&connections[i]->id==id)return connections[i];
    return NULL;
}
static int put(Queue *queue,const unsigned char *bytes,size_t length) {
    if(length>TLS_CAPACITY-queue->length)length=TLS_CAPACITY-queue->length;
    for(size_t i=0;i<length;i++)queue->data[(queue->start+queue->length+i)%TLS_CAPACITY]=bytes[i];
    queue->length+=length;return (int)length;
}
static int take(Queue *queue,unsigned char *bytes,size_t length) {
    if(length>queue->length)length=queue->length;
    for(size_t i=0;i<length;i++){
        size_t index=(queue->start+i)%TLS_CAPACITY;
        bytes[i]=queue->data[index];queue->data[index]=0;
    }
    queue->start=(queue->start+length)%TLS_CAPACITY;queue->length-=length;return (int)length;
}
static int send_bytes(void *data,const unsigned char *bytes,size_t length) {
    int result=put(&((Connection *)data)->output,bytes,length);
    return result?result:MBEDTLS_ERR_SSL_WANT_WRITE;
}
static int receive_bytes(void *data,unsigned char *bytes,size_t length) {
    Connection *connection=data;int result=take(&connection->input,bytes,length);
    return result?result:connection->closed?0:MBEDTLS_ERR_SSL_WANT_READ;
}
static void release(Connection *connection) {
    mbedtls_ssl_free(&connection->ssl);mbedtls_ssl_config_free(&connection->config);
    mbedtls_x509_crt_free(&connection->ca);mbedtls_x509_crt_free(&connection->certificate);
    mbedtls_pk_free(&connection->key);mbedtls_ctr_drbg_free(&connection->rng);mbedtls_entropy_free(&connection->entropy);
    deallocate(connection);
}
int tls_initialize(int bytes,int count) {
    if(initialized||allocated||bytes<0||count<1||count>TLS_MAX_CONNECTIONS)return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    limit=(size_t)bytes;peak=0;max_connections=count;
    mbedtls_platform_set_calloc_free(allocate,deallocate);
    int result=(int)psa_crypto_init();
    if(result){mbedtls_psa_crypto_free();return result;}
    initialized=1;return 0;
}
void *tls_allocate(int bytes) { return initialized&&bytes>=0?allocate(1,(size_t)bytes):NULL; }
void tls_deallocate(void *pointer) { deallocate(pointer); }
int tls_allocated(void) {return (int)allocated;}
int tls_peak(void) {return (int)peak;}
int tls_shutdown(void) {
    for(int i=0;i<max_connections;i++)if(connections[i]){release(connections[i]);connections[i]=NULL;}
    mbedtls_psa_crypto_free();initialized=0;
    return (int)allocated;
}
/* Node's SetCACert reads PEM certificates until parsing stops. Invalid CA
 * text adds no trust; it does not disable verification. Allocation failures
 * must remain errors, rather than being mistaken for malformed input. */
static int parse_node_ca(mbedtls_x509_crt *chain,const unsigned char *input,size_t length) {
    unsigned char *text=allocate(1,length+1);
    if(!text)return MBEDTLS_ERR_X509_ALLOC_FAILED;
    memcpy(text,input,length);text[length]=0;
    const unsigned char *cursor=text;int result=0;
    while(*cursor){
        size_t failures_before=allocation_failures;
        mbedtls_pem_context pem;mbedtls_pem_init(&pem);size_t used=0;
        int parsed=mbedtls_pem_read_buffer(&pem,"-----BEGIN CERTIFICATE-----","-----END CERTIFICATE-----",cursor,NULL,0,&used);
        if(!parsed){size_t der_length;const unsigned char *der=mbedtls_pem_get_buffer(&pem,&der_length);parsed=mbedtls_x509_crt_parse_der(chain,der,der_length);}
        mbedtls_pem_free(&pem);
        if(parsed){
            if(allocation_failures!=failures_before)result=MBEDTLS_ERR_X509_ALLOC_FAILED;
            break;
        }
        if(!used||used>length-(size_t)(cursor-text))break;
        cursor+=used;
    }
    deallocate(text);return result;
}
static int open_connection(int server,const unsigned char *ca,int ca_length,const unsigned char *cert,int cert_length,
             const unsigned char *key,int key_length,const char *hostname,int minimum,int maximum,int verification,int node_ca) {
    if(!initialized||(server!=0&&server!=1)||ca_length<0||ca_length>TLS_MAX_PEM||cert_length<0||cert_length>TLS_MAX_PEM||key_length<0||key_length>65536||
       minimum<12||maximum>13||minimum>maximum||verification<0||verification>2||(!server&&(!hostname||!hostname[0])))return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    int slot=0;while(slot<max_connections&&connections[slot])slot++;
    if(slot==max_connections||next_id==INT_MAX)return MBEDTLS_ERR_SSL_ALLOC_FAILED;
    Connection *connection=allocate(1,sizeof(Connection));
    if(!connection)return MBEDTLS_ERR_SSL_ALLOC_FAILED;
    mbedtls_ssl_init(&connection->ssl);mbedtls_ssl_config_init(&connection->config);
    mbedtls_ctr_drbg_init(&connection->rng);mbedtls_entropy_init(&connection->entropy);
    mbedtls_x509_crt_init(&connection->ca);mbedtls_x509_crt_init(&connection->certificate);mbedtls_pk_init(&connection->key);
    int result;
#define TRY(expression) do{result=(expression);if(result)goto failure;}while(0)
    static const unsigned char label[]="web-container-owned-tls";
    TRY(mbedtls_ctr_drbg_seed(&connection->rng,mbedtls_entropy_func,&connection->entropy,label,sizeof(label)-1));
    TRY(mbedtls_ssl_config_defaults(&connection->config,server?MBEDTLS_SSL_IS_SERVER:MBEDTLS_SSL_IS_CLIENT,MBEDTLS_SSL_TRANSPORT_STREAM,MBEDTLS_SSL_PRESET_DEFAULT));
    mbedtls_ssl_conf_min_tls_version(&connection->config,minimum==12?MBEDTLS_SSL_VERSION_TLS1_2:MBEDTLS_SSL_VERSION_TLS1_3);
    mbedtls_ssl_conf_max_tls_version(&connection->config,maximum==12?MBEDTLS_SSL_VERSION_TLS1_2:MBEDTLS_SSL_VERSION_TLS1_3);
    mbedtls_ssl_conf_rng(&connection->config,mbedtls_ctr_drbg_random,&connection->rng);
    if(ca_length)TRY(node_ca?parse_node_ca(&connection->ca,ca,(size_t)ca_length):mbedtls_x509_crt_parse(&connection->ca,ca,(size_t)ca_length));
    mbedtls_ssl_conf_ca_chain(&connection->config,&connection->ca,NULL);
    if(cert_length)TRY(mbedtls_x509_crt_parse(&connection->certificate,cert,(size_t)cert_length));
    if(key_length)TRY(mbedtls_pk_parse_key(&connection->key,key,(size_t)key_length,NULL,0,mbedtls_ctr_drbg_random,&connection->rng));
    if(cert_length&&key_length){
        TRY(mbedtls_pk_check_pair(&connection->certificate.pk,&connection->key,mbedtls_ctr_drbg_random,&connection->rng));
        TRY(mbedtls_ssl_conf_own_cert(&connection->config,&connection->certificate,&connection->key));
    }
    mbedtls_ssl_conf_authmode(&connection->config,verification);
    TRY(mbedtls_ssl_setup(&connection->ssl,&connection->config));
    if(hostname&&hostname[0])TRY(mbedtls_ssl_set_hostname(&connection->ssl,hostname));
    mbedtls_ssl_set_bio(&connection->ssl,connection,send_bytes,receive_bytes,NULL);
    connection->id=next_id++;connections[slot]=connection;return connection->id;
failure:
    release(connection);return result;
#undef TRY
}
int tls_open(int server,const unsigned char *ca,int ca_length,const unsigned char *cert,int cert_length,
             const unsigned char *key,int key_length,const char *hostname,int minimum,int maximum,int verification) {
    return open_connection(server,ca,ca_length,cert,cert_length,key,key_length,hostname,minimum,maximum,verification,0);
}
int tls_open_node(int server,const unsigned char *ca,int ca_length,const unsigned char *cert,int cert_length,
             const unsigned char *key,int key_length,const char *hostname,int minimum,int maximum,int verification) {
    return open_connection(server,ca,ca_length,cert,cert_length,key,key_length,hostname,minimum,maximum,verification,1);
}
static int status(Connection *connection,int result) {
    if(result<0&&result!=MBEDTLS_ERR_SSL_WANT_READ&&result!=MBEDTLS_ERR_SSL_WANT_WRITE&&result!=MBEDTLS_ERR_SSL_CRYPTO_IN_PROGRESS&&result!=MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY)
        connection->failed=result;
    return result;
}
int tls_step(int id) {
    Connection *connection=find(id);if(!connection)return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    if(connection->failed)return connection->failed;
    if(mbedtls_ssl_is_handshake_over(&connection->ssl))return 0;
    int result=status(connection,mbedtls_ssl_handshake_step(&connection->ssl));
    return result?result:mbedtls_ssl_is_handshake_over(&connection->ssl)?0:1;
}
int tls_feed(int id,const unsigned char *bytes,int length) {
    Connection *connection=find(id);if(!connection||length<0||connection->closed)return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return put(&connection->input,bytes,(size_t)length);
}
int tls_drain(int id,unsigned char *bytes,int length) {
    Connection *connection=find(id);if(!connection||length<0)return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return take(&connection->output,bytes,(size_t)length);
}
int tls_read(int id,unsigned char *bytes,int length) {
    Connection *connection=find(id);if(!connection||length<0||!mbedtls_ssl_is_handshake_over(&connection->ssl))return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return connection->failed?connection->failed:status(connection,mbedtls_ssl_read(&connection->ssl,bytes,(size_t)length));
}
int tls_write(int id,const unsigned char *bytes,int length) {
    Connection *connection=find(id);if(!connection||length<0||!mbedtls_ssl_is_handshake_over(&connection->ssl))return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return connection->failed?connection->failed:status(connection,mbedtls_ssl_write(&connection->ssl,bytes,(size_t)length));
}
int tls_eof(int id) {Connection *connection=find(id);if(!connection)return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;connection->closed=1;return 0;}
int tls_close(int id) {
    Connection *connection=find(id);if(!connection)return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return connection->failed?connection->failed:status(connection,mbedtls_ssl_close_notify(&connection->ssl));
}
int tls_destroy(int id) {
    for(int i=0;i<max_connections;i++)if(connections[i]&&connections[i]->id==id){release(connections[i]);connections[i]=NULL;return 0;}
    return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
}
int tls_verify(int id) {Connection *connection=find(id);return connection?(int)mbedtls_ssl_get_verify_result(&connection->ssl):-1;}
const char *tls_protocol(int id) {Connection *connection=find(id);return connection?mbedtls_ssl_get_version(&connection->ssl):"";}
const char *tls_error(int code) {static char error[256];mbedtls_strerror(code,error,sizeof(error));return error;}
