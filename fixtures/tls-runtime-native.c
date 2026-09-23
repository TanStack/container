#include <stdio.h>
#include "../src/sandbox/tls-runtime.c"

static unsigned char *load(const char *path,int *length){
    FILE *file=fopen(path,"rb");if(!file)return NULL;
    if(fseek(file,0,SEEK_END)||ftell(file)<0||ftell(file)>1048575){fclose(file);return NULL;}
    *length=(int)ftell(file)+1;rewind(file);
    unsigned char *value=calloc(1,(size_t)*length);
    if(!value||fread(value,1,(size_t)*length-1,file)!=(size_t)*length-1){free(value);fclose(file);return NULL;}
    fclose(file);return value;
}
static int is_pending(int code){return code==1||code==MBEDTLS_ERR_SSL_WANT_READ||code==MBEDTLS_ERR_SSL_WANT_WRITE||code==MBEDTLS_ERR_SSL_CRYPTO_IN_PROGRESS;}
static int move(int from,int to){
    unsigned char bytes[65536];int length=tls_drain(from,bytes,sizeof(bytes));
    return length>=0&&tls_feed(to,bytes,length)==length?0:-1;
}
int main(int argc,char **argv){
    if(argc!=4)return 2;
    int ca_length,cert_length,key_length;
    unsigned char *ca=load(argv[1],&ca_length),*cert=load(argv[2],&cert_length),*key=load(argv[3],&key_length);
    if(!ca||!cert||!key)return 3;
    int budgets[]={65536,131072,196608,262144,524288,1048576,2097152};
    int attempts=0,successes=0,failures=0,previous=0;
    for(int node_ca=0;node_ca<=1;node_ca++)for(int repeat=0;repeat<3;repeat++)for(int version=12;version<=13;version++)for(size_t i=0;i<sizeof(budgets)/sizeof(budgets[0]);i++){
        int budget=budgets[i],result=tls_initialize(budget,4),client=-1,server=-1,client_status=1,server_status=1;
        if(!result){
            client=(node_ca?tls_open_node:tls_open)(0,ca,ca_length,NULL,0,NULL,0,"localhost",version,version,2);
            if(client>0){
                if(client<=previous)return 4;
                previous=client;
                server=tls_open(1,NULL,0,cert,cert_length,key,key_length,"",version,version,0);
            }
            if(client>0&&server>0)for(int step=0;step<10000;step++){
                if(client_status)client_status=tls_step(client);
                if(server_status)server_status=tls_step(server);
                if((client_status&&!is_pending(client_status))||(server_status&&!is_pending(server_status)))break;
                if(move(client,server)||move(server,client))return 5;
                if(!client_status&&!server_status)break;
            }
        }
        int success=!result&&client>0&&server>0&&!client_status&&!server_status;
        if(success){
            static const unsigned char message[]="owned native TLS";unsigned char received[64];
            if(tls_write(client,message,sizeof(message))!=(int)sizeof(message)||move(client,server)||tls_read(server,received,sizeof(received))!=(int)sizeof(message)||memcmp(message,received,sizeof(message)))return 6;
            if(tls_verify(client)!=0)return 7;
            if(tls_destroy(client)||tls_step(client)!=MBEDTLS_ERR_SSL_BAD_INPUT_DATA)return 8;
            successes++;
        }else failures++;
        if(tls_peak()>budget||tls_shutdown()!=0)return 9;
        if(budget==2097152&&!success)return 10;
        // Each iteration repeats initialization on the same C globals after
        // freeing PSA state, including after failed construction/handshakes.
        attempts++;
    }
    free(ca);free(cert);mbedtls_platform_zeroize(key,(size_t)key_length);free(key);
    printf("{\"attempts\":%d,\"successes\":%d,\"failures\":%d,\"recovered\":%d,\"liveBytes\":%d}\n",attempts,successes,failures,attempts,tls_allocated());
    return !successes||!failures;
}
