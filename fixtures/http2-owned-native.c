#include <assert.h>
#include <stdio.h>
#include "../src/sandbox/http2-runtime.c"

static int exchange(int client,int server) {
    unsigned char wire[16384],body[23];memset(body,42,sizeof(body));
    const unsigned char headers[]=":method\0POST\0:scheme\0http\0:authority\0localhost\0:path\0/owned\0x-owned\00042\0";
    int stream=h2_headers(client,0,headers,sizeof(headers)-1,0,0);
    if(stream<0)return stream;
    int written=h2_write(client,stream,body,sizeof(body),1);if(written<0)return written;assert(written==sizeof(body));
    int received=0,ended=0;
    for(int iteration=0;iteration<10000;iteration++){
        int a=h2_send(client,wire,13);if(a<0)return a;
        if(a){int result=h2_feed(server,wire,a);if(result<0)return result;}
        while(h2_event_type(server)>0){
            int type=h2_event_type(server),flags=h2_event_flags(server),id=h2_event_stream(server),length=h2_event_length(server);
            if(type==2){const unsigned char *bytes=h2_event_data(server);for(int i=0;i<length;i++)assert(bytes[i]==42);int result=h2_consume(server,id,length);if(result<0)return result;}
            if(type==3&&(flags&1)){
                const unsigned char response[]=":status\000200\0x-owned\00042\0";
                int result=h2_headers(server,id,response,sizeof(response)-1,0,0);if(result<0)return result;
                result=h2_write(server,id,body,sizeof(body),1);if(result<0)return result;assert(result==sizeof(body));
            }
            h2_pop(server);
        }
        int b=h2_send(server,wire,13);if(b<0)return b;
        if(b){int result=h2_feed(client,wire,b);if(result<0)return result;}
        while(h2_event_type(client)>0){
            int type=h2_event_type(client),flags=h2_event_flags(client),id=h2_event_stream(client),length=h2_event_length(client);
            if(type==2){const unsigned char *bytes=h2_event_data(client);for(int i=0;i<length;i++)assert(bytes[i]==42);received+=length;int result=h2_consume(client,id,length);if(result<0)return result;}
            if(type==3&&(flags&1))ended=1;
            h2_pop(client);
        }
        if(ended){assert(received==23);return 0;}
        if(!a&&!b)break;
    }
    assert(!"Incomplete HTTP/2 exchange");return -1;
}

int main(void){
    int successes=0,failures=0,previous=0;
    for(int maximum=65536;maximum<=1048576;maximum+=4096){
        assert(h2_initialize(maximum,4)==0);
        int ids[4]={0},result=0;
        for(int i=0;i<4;i++){
            ids[i]=h2_open(i%2);
            if(ids[i]<0){result=ids[i];break;}
            assert(ids[i]>previous);previous=ids[i];
        }
        if(!result){
            assert(h2_count()==4&&h2_open(0)<0);
            result=exchange(ids[0],ids[1]);
            if(!result){
                assert(h2_destroy(ids[0])==0&&h2_destroy(ids[1])==0);
                unsigned char byte=0;
                assert(h2_feed(ids[0],&byte,1)<0&&h2_send(ids[0],&byte,1)<0);
                assert(h2_request_start(ids[0],"POST","/","localhost")<0);
                assert(h2_consume(ids[0],1,1)<0&&h2_reset(ids[0],1,8)<0);
                assert(h2_event_type(ids[0])<0&&h2_destroy(ids[0])<0);
                result=exchange(ids[2],ids[3]);
            }
        }
        if(result<0)failures++;else successes++;
        assert(h2_peak()<=maximum);
        assert(h2_shutdown()==0&&h2_count()==0);
        assert(h2_initialize(1048576,2)==0);
        int client=h2_open(0),server=h2_open(1);
        assert(client>previous&&server>client);previous=server;
        assert(exchange(client,server)==0);
        assert(h2_shutdown()==0);
    }
    assert(successes>0&&failures>0);
    const unsigned char partial[]=":method\0GET\0:scheme\0http\0:authority\0localhost\0:path\0/\0";
    assert(h2_initialize(1048576,2)==0);
    for(int length=0;length<(int)sizeof(partial);length++){
        int peer=h2_open(0);assert(peer>0);
        h2_headers(peer,0,partial,length,1,0);
        assert(h2_destroy(peer)==0);
    }
    assert(h2_shutdown()==0);
    printf("{\"cycles\":%d,\"successes\":%d,\"failures\":%d,\"remainingBytes\":%d}\n",successes+failures,successes,failures,h2_allocated());
    return 0;
}
