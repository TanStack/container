#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include "mbedtls/platform.h"
#include "mbedtls/ssl.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/x509_crt.h"
#include "mbedtls/pk.h"
#include "psa/crypto.h"
#include "tls-probe-certificates.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(int, secure_random, (unsigned char *out, size_t length), {
    try {
        for (let offset=0; offset<length; offset+=65536)
            globalThis.crypto.getRandomValues(HEAPU8.subarray(out+offset,out+Math.min(length,offset+65536)));
        return 0;
    } catch (_) { return -1; }
});
#else
static int secure_random(unsigned char *out, size_t length) {
    arc4random_buf(out, length);
    return 0;
}
#endif

typedef union { max_align_t alignment; size_t size; } Allocation;
static size_t live_bytes, peak_bytes, allocation_count, memory_limit, fail_at;
static int entropy_failure;
static void *tracked_calloc(size_t count, size_t size) {
    allocation_count++;
    if (allocation_count == fail_at || (size && count > (SIZE_MAX-sizeof(Allocation))/size)) return NULL;
    size_t bytes=count*size+sizeof(Allocation);
    if (bytes>memory_limit || live_bytes>memory_limit-bytes) return NULL;
    Allocation *allocation=calloc(1,bytes);
    if (!allocation) return NULL;
    allocation->size=bytes; live_bytes+=bytes;
    if (live_bytes>peak_bytes) peak_bytes=live_bytes;
    return allocation+1;
}
static void tracked_free(void *pointer) {
    if (!pointer) return;
    Allocation *allocation=((Allocation *)pointer)-1;
    if (allocation->size>live_bytes) abort();
    live_bytes-=allocation->size;
    free(allocation);
}
int mbedtls_hardware_poll(void *context, unsigned char *output, size_t length, size_t *written) {
    (void)context; *written=0;
    if (entropy_failure || secure_random(output,length)) return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
    *written=length; return 0;
}

#define CAPACITY 65536
typedef struct { unsigned char bytes[CAPACITY]; size_t start, length; } Queue;
typedef struct Endpoint {
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config config;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context rng;
    mbedtls_x509_crt certificate, ca;
    mbedtls_pk_context key;
    Queue incoming;
    Queue *outgoing;
    struct Endpoint *peer;
    size_t fragment, wire_bytes;
} Endpoint;
static int send_bytes(void *data, const unsigned char *bytes, size_t length) {
    Endpoint *endpoint=data; Queue *queue=endpoint->peer?&endpoint->peer->incoming:endpoint->outgoing;
    if (length>endpoint->fragment) length=endpoint->fragment;
    if (length>CAPACITY-queue->length) length=CAPACITY-queue->length;
    if (!length) return MBEDTLS_ERR_SSL_WANT_WRITE;
    for (size_t i=0;i<length;i++) queue->bytes[(queue->start+queue->length+i)%CAPACITY]=bytes[i];
    queue->length+=length; endpoint->wire_bytes+=length;
    return (int)length;
}
static int receive_bytes(void *data, unsigned char *bytes, size_t length) {
    Endpoint *endpoint=data; Queue *queue=&endpoint->incoming;
    if (length>endpoint->fragment) length=endpoint->fragment;
    if (length>queue->length) length=queue->length;
    if (!length) return MBEDTLS_ERR_SSL_WANT_READ;
    for (size_t i=0;i<length;i++) bytes[i]=queue->bytes[(queue->start+i)%CAPACITY];
    queue->start=(queue->start+length)%CAPACITY; queue->length-=length;
    return (int)length;
}
static int pending(int result) { return result==MBEDTLS_ERR_SSL_WANT_READ || result==MBEDTLS_ERR_SSL_WANT_WRITE || result==MBEDTLS_ERR_SSL_CRYPTO_IN_PROGRESS; }
static void initialize(Endpoint *endpoint) {
    mbedtls_ssl_init(&endpoint->ssl); mbedtls_ssl_config_init(&endpoint->config);
    mbedtls_entropy_init(&endpoint->entropy); mbedtls_ctr_drbg_init(&endpoint->rng);
    mbedtls_x509_crt_init(&endpoint->certificate); mbedtls_x509_crt_init(&endpoint->ca); mbedtls_pk_init(&endpoint->key);
}
static void release(Endpoint *endpoint) {
    mbedtls_ssl_free(&endpoint->ssl); mbedtls_ssl_config_free(&endpoint->config);
    mbedtls_x509_crt_free(&endpoint->certificate); mbedtls_x509_crt_free(&endpoint->ca);
    mbedtls_pk_free(&endpoint->key); mbedtls_ctr_drbg_free(&endpoint->rng); mbedtls_entropy_free(&endpoint->entropy);
}
static int configure(Endpoint *endpoint, int server, int mode, int version) {
    int result;
#define CHECK(expression) do { result=(expression); if(result) return result; } while(0)
    const unsigned char label[]="web-container-tls-probe";
    CHECK(mbedtls_ctr_drbg_seed(&endpoint->rng,mbedtls_entropy_func,&endpoint->entropy,label,sizeof(label)-1));
    CHECK(mbedtls_ssl_config_defaults(&endpoint->config,server?MBEDTLS_SSL_IS_SERVER:MBEDTLS_SSL_IS_CLIENT,MBEDTLS_SSL_TRANSPORT_STREAM,MBEDTLS_SSL_PRESET_DEFAULT));
    mbedtls_ssl_protocol_version protocol=version==13?MBEDTLS_SSL_VERSION_TLS1_3:MBEDTLS_SSL_VERSION_TLS1_2;
    mbedtls_ssl_conf_min_tls_version(&endpoint->config,protocol);
    mbedtls_ssl_conf_max_tls_version(&endpoint->config,protocol);
    mbedtls_ssl_conf_rng(&endpoint->config,mbedtls_ctr_drbg_random,&endpoint->rng);
    if (server) {
        CHECK(mbedtls_x509_crt_parse(&endpoint->certificate,server_certificate,sizeof(server_certificate)));
        CHECK(mbedtls_pk_parse_key(&endpoint->key,server_key,sizeof(server_key),NULL,0,mbedtls_ctr_drbg_random,&endpoint->rng));
        CHECK(mbedtls_ssl_conf_own_cert(&endpoint->config,&endpoint->certificate,&endpoint->key));
        mbedtls_ssl_conf_authmode(&endpoint->config,MBEDTLS_SSL_VERIFY_NONE);
    } else {
        const unsigned char *ca=mode==3?(const unsigned char *)"not a certificate":ca_certificate;
        size_t length=mode==3?18:sizeof(ca_certificate);
        if (mode!=2) CHECK(mbedtls_x509_crt_parse(&endpoint->ca,ca,length));
        mbedtls_ssl_conf_ca_chain(&endpoint->config,&endpoint->ca,NULL);
        mbedtls_ssl_conf_authmode(&endpoint->config,MBEDTLS_SSL_VERIFY_REQUIRED);
    }
    CHECK(mbedtls_ssl_setup(&endpoint->ssl,&endpoint->config));
    if (!server) CHECK(mbedtls_ssl_set_hostname(&endpoint->ssl,mode==1?"wrong.invalid":"localhost"));
    mbedtls_ssl_set_bio(&endpoint->ssl,endpoint,send_bytes,receive_bytes,NULL);
    return 0;
#undef CHECK
}

/* Test-only host adapter for an independent TLS implementation. The eventual
 * guest binding needs per-owner handles, quotas and cancellation, not this
 * single-peer harness API. It never opens an operating-system socket. */
static Endpoint *external_peer;
int tls_peer_destroy(void) {
    if(external_peer){
        release(external_peer);tracked_free(external_peer->outgoing);
        tracked_free(external_peer);external_peer=NULL;
    }
    mbedtls_psa_crypto_free();
    return (int)live_bytes;
}
int tls_peer_open(int server,int version) {
    if(external_peer||live_bytes||(server!=0&&server!=1)||(version!=12&&version!=13))return -1;
    peak_bytes=allocation_count=0; memory_limit=2097152;fail_at=0;entropy_failure=0;
    mbedtls_platform_set_calloc_free(tracked_calloc,tracked_free);
    external_peer=tracked_calloc(1,sizeof(Endpoint));
    if(!external_peer)return MBEDTLS_ERR_SSL_ALLOC_FAILED;
    initialize(external_peer);external_peer->fragment=CAPACITY;
    external_peer->outgoing=tracked_calloc(1,sizeof(Queue));
    int result=external_peer->outgoing?(int)psa_crypto_init():MBEDTLS_ERR_SSL_ALLOC_FAILED;
    if(!result)result=configure(external_peer,server,0,version);
    if(result)tls_peer_destroy();
    return result;
}
int tls_peer_feed(const unsigned char *bytes,int length) {
    if(!external_peer||length<0||(size_t)length>CAPACITY-external_peer->incoming.length)return -1;
    Queue *queue=&external_peer->incoming;
    for(int i=0;i<length;i++)queue->bytes[(queue->start+queue->length+(size_t)i)%CAPACITY]=bytes[i];
    queue->length+=(size_t)length;return length;
}
int tls_peer_drain(unsigned char *bytes,int capacity) {
    if(!external_peer||capacity<0)return -1;
    Queue *queue=external_peer->outgoing;
    size_t length=(size_t)capacity<queue->length?(size_t)capacity:queue->length;
    for(size_t i=0;i<length;i++)bytes[i]=queue->bytes[(queue->start+i)%CAPACITY];
    queue->start=(queue->start+length)%CAPACITY;queue->length-=length;
    return (int)length;
}
int tls_peer_handshake(void) {return external_peer?mbedtls_ssl_handshake(&external_peer->ssl):-1;}
int tls_peer_read(unsigned char *bytes,int capacity) {return external_peer&&capacity>=0?mbedtls_ssl_read(&external_peer->ssl,bytes,(size_t)capacity):-1;}
int tls_peer_write(const unsigned char *bytes,int length) {return external_peer&&length>=0?mbedtls_ssl_write(&external_peer->ssl,bytes,(size_t)length):-1;}
int tls_peer_close(void) {return external_peer?mbedtls_ssl_close_notify(&external_peer->ssl):-1;}

static int transfer(Endpoint *sender, Endpoint *receiver, const unsigned char *text, size_t length, int tamper) {
    int result=mbedtls_ssl_write(&sender->ssl,text,length);
    if (result!=(int)length) return result?result:-1;
    if (tamper) {
        Queue *queue=&receiver->incoming;
        if (!queue->length) return -1;
        queue->bytes[(queue->start+queue->length-1)%CAPACITY]^=1;
    }
    unsigned char received[512]; size_t offset=0;
    for(int step=0;step<10000&&offset<length;step++) {
        result=mbedtls_ssl_read(&receiver->ssl,received+offset,sizeof(received)-offset);
        if(pending(result))continue;
        if(result<=0)return result?result:-1;
        offset+=(size_t)result;
    }
    return offset==length&&!memcmp(received,text,length)?0:-1;
}

/* Standalone protocol probe, not yet a guest builtin or a network permission. */
int tls_probe(int mode, int fragment, int version, int budget, int fail_index) {
    if(live_bytes || mode<0 || mode>5 || fragment<1 || fragment>CAPACITY || (version!=12&&version!=13) || budget<0 || fail_index<0) return 2;
    peak_bytes=allocation_count=0; memory_limit=(size_t)budget; fail_at=(size_t)fail_index; entropy_failure=mode==5;
    mbedtls_platform_set_calloc_free(tracked_calloc,tracked_free);
    Endpoint *pair=tracked_calloc(2,sizeof(Endpoint));
    int setup=0,client=MBEDTLS_ERR_SSL_WANT_READ,server=MBEDTLS_ERR_SSL_WANT_READ;
    int request=-1,response=-1,closed=0,steps=0; uint32_t flags=0; size_t wire=0;
    const char *negotiated="";
    char protocol[24]={0};
    if(!pair){setup=MBEDTLS_ERR_SSL_ALLOC_FAILED;goto finish;}
    initialize(&pair[0]); initialize(&pair[1]);
    pair[0].peer=&pair[1];pair[1].peer=&pair[0];pair[0].fragment=pair[1].fragment=(size_t)fragment;
    setup=(int)psa_crypto_init();
    if(!setup)setup=configure(&pair[0],0,mode,version);
    if(!setup)setup=configure(&pair[1],1,mode,version);
    if(!setup) {
        for(;steps<10000;steps++) {
            if(client)client=mbedtls_ssl_handshake(&pair[0].ssl);
            if(client&&!pending(client))break;
            if(server)server=mbedtls_ssl_handshake(&pair[1].ssl);
            if(server&&!pending(server))break;
            if(!client&&!server)break;
        }
        flags=mbedtls_ssl_get_verify_result(&pair[0].ssl);
        if(!client&&!server) {
            negotiated=mbedtls_ssl_get_version(&pair[0].ssl);
            snprintf(protocol,sizeof(protocol),"%s",negotiated);
            static const unsigned char query[]="GET /answer HTTP/1.1\r\nHost: localhost\r\n\r\n";
            static const unsigned char answer[]="HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n42";
            request=transfer(&pair[0],&pair[1],query,sizeof(query)-1,mode==4);
            if(!request)response=transfer(&pair[1],&pair[0],answer,sizeof(answer)-1,0);
            if(!request&&!response&&!mbedtls_ssl_close_notify(&pair[1].ssl)) {
                unsigned char byte;
                closed=mbedtls_ssl_read(&pair[0].ssl,&byte,1)==MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY;
            }
        }
    }
    wire=pair[0].wire_bytes+pair[1].wire_bytes;
    release(&pair[0]);release(&pair[1]);tracked_free(pair);
finish:
    mbedtls_psa_crypto_free();
    int accepted=!setup&&!client&&!server&&!request&&!response&&closed;
    int expected=mode==0?accepted:mode==4?(!setup&&!client&&!server&&request==MBEDTLS_ERR_SSL_INVALID_MAC):mode==1?(!setup&&client==MBEDTLS_ERR_X509_CERT_VERIFY_FAILED&&(flags&MBEDTLS_X509_BADCERT_CN_MISMATCH)):mode==2?(!setup&&client==MBEDTLS_ERR_X509_CERT_VERIFY_FAILED&&(flags&MBEDTLS_X509_BADCERT_NOT_TRUSTED)):setup!=0;
    printf("{\"mode\":%d,\"fragment\":%d,\"version\":%d,\"budget\":%d,\"failAt\":%d,\"setup\":%d,\"client\":%d,\"server\":%d,\"verifyFlags\":%u,\"request\":%d,\"response\":%d,\"closed\":%d,\"protocol\":\"%s\",\"steps\":%d,\"wireBytes\":%zu,\"allocations\":%zu,\"peakBytes\":%zu,\"liveBytes\":%zu,\"accepted\":%d,\"expected\":%d}\n",mode,fragment,version,budget,fail_index,setup,client,server,flags,request,response,closed,protocol,steps,wire,allocation_count,peak_bytes,live_bytes,accepted,!!expected);
    return live_bytes?3:0;
}
#ifndef __EMSCRIPTEN__
int main(int argc,char **argv) {
    if(argc!=6)return 2;
    return tls_probe(atoi(argv[1]),atoi(argv[2]),atoi(argv[3]),atoi(argv[4]),atoi(argv[5]));
}
#endif
