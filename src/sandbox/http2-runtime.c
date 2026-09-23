#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <nghttp2/nghttp2.h>

/* One owner per module, with separate protocol state for each session. */
typedef union { max_align_t align;size_t size; } Allocation;
static size_t live,peak,budget;
static void *reserve(size_t n,void *unused){
    (void)unused;if(n>SIZE_MAX-sizeof(Allocation))return NULL;
    n+=sizeof(Allocation);if(n>budget||live>budget-n)return NULL;
    Allocation *p=malloc(n);if(!p)return NULL;p->size=n;live+=n;if(live>peak)peak=live;return p+1;
}
static void release(void *p,void *unused){
    (void)unused;if(!p)return;Allocation *a=(Allocation *)p-1;live-=a->size;memset(a,0,a->size);free(a);
}
static void *zeroed(size_t n,size_t size,void *unused){if(size&&n>SIZE_MAX/size)return NULL;void *p=reserve(n*size,unused);if(p)memset(p,0,n*size);return p;}
static void *resize(void *p,size_t n,void *unused){
    if(!p)return reserve(n,unused);if(!n){release(p,unused);return NULL;}
    void *next=reserve(n,unused);if(!next)return NULL;size_t old=((Allocation *)p-1)->size-sizeof(Allocation);memcpy(next,p,old<n?old:n);release(p,unused);return next;
}
typedef struct Event {struct Event *next;int type,stream,flags;size_t length;unsigned char bytes[];} Event;
typedef struct Chunk {struct Chunk *next;size_t length,offset;unsigned char bytes[];} Chunk;
typedef struct Body {struct Body *next;int stream,ended,deferred,wait_trailers,want_trailers,sent_trailers;size_t queued;Chunk *first,*last;} Body;
typedef struct Credit {struct Credit *next;int stream;size_t pending;} Credit;
typedef struct Peer {
    nghttp2_session *session;
    Event *first,*last;
    Body *bodies;
    Credit *credits;
    size_t event_bytes,event_count,header_bytes,header_count;
    const uint8_t *pending;
    size_t pending_length,pending_offset;
    int id;
} Peer;
static Peer *peers[32];
static int initialized,session_limit,next_id=1;
static Peer *lookup(int id){if(id<=0)return NULL;for(int i=0;i<32;i++)if(peers[i]&&peers[i]->id==id)return peers[i];return NULL;}
static int emit(Peer *peer,int type,int stream,int flags,const void *bytes,size_t length){
    if(peer->event_count>=256||length>262144-peer->event_bytes)return NGHTTP2_ERR_CALLBACK_FAILURE;
    Event *event=reserve(sizeof(Event)+length,NULL);if(!event)return NGHTTP2_ERR_CALLBACK_FAILURE;
    *event=(Event){.type=type,.stream=stream,.flags=flags,.length=length};if(length)memcpy(event->bytes,bytes,length);
    if(peer->last)peer->last->next=event;else peer->first=event;peer->last=event;peer->event_count++;peer->event_bytes+=length;return 0;
}
static void peer_pop(Peer *peer){if(!peer->first)return;Event *event=peer->first;peer->first=event->next;if(!peer->first)peer->last=NULL;peer->event_count--;peer->event_bytes-=event->length;release(event,NULL);}
static int peer_event_type(Peer *peer){return peer->first?peer->first->type:0;}
static int peer_event_stream(Peer *peer){return peer->first?peer->first->stream:0;}
static int peer_event_flags(Peer *peer){return peer->first?peer->first->flags:0;}
static int peer_event_length(Peer *peer){return peer->first?(int)peer->first->length:0;}
static const void *peer_event_data(Peer *peer){return peer->first?peer->first->bytes:NULL;}
static int begin_headers(nghttp2_session *s,const nghttp2_frame *f,void *u){Peer *peer=u;(void)s;(void)f;(void)u;peer->header_bytes=peer->header_count=0;return 0;}
static int header(nghttp2_session *s,const nghttp2_frame *f,const uint8_t *name,size_t n,const uint8_t *value,size_t v,uint8_t flags,void *u){Peer *peer=u;
    (void)s;(void)flags;(void)u;if(++peer->header_count>128||n>65536-peer->header_bytes||v>65536-peer->header_bytes-n)return NGHTTP2_ERR_TEMPORAL_CALLBACK_FAILURE;
    peer->header_bytes+=n+v;unsigned char *joined=reserve(n+v+1,NULL);if(!joined)return NGHTTP2_ERR_CALLBACK_FAILURE;
    memcpy(joined,name,n);joined[n]=0;memcpy(joined+n+1,value,v);int result=emit(peer,1,f->hd.stream_id,0,joined,n+v+1);release(joined,NULL);return result;
}
static int data(nghttp2_session *s,uint8_t flags,int32_t stream,const uint8_t *bytes,size_t length,void *u){Peer *peer=u;
    (void)s;(void)u;if(!length)return 0;
    Credit *credit=peer->credits;while(credit&&credit->stream!=stream)credit=credit->next;
    if(!credit){credit=reserve(sizeof(Credit),NULL);if(!credit)return NGHTTP2_ERR_CALLBACK_FAILURE;*credit=(Credit){.next=peer->credits,.stream=stream};peer->credits=credit;}
    int result=emit(peer,2,stream,flags,bytes,length);if(!result)credit->pending+=length;return result;
}
static int frame(nghttp2_session *s,const nghttp2_frame *f,void *u){Peer *peer=u;
    (void)s;(void)u;if(f->hd.type==NGHTTP2_HEADERS||f->hd.type==NGHTTP2_DATA)return emit(peer,f->hd.type==NGHTTP2_HEADERS&&f->headers.cat==NGHTTP2_HCAT_HEADERS?7:3,f->hd.stream_id,f->hd.flags,NULL,0);
    if(f->hd.type==NGHTTP2_GOAWAY)return emit(peer,5,f->goaway.last_stream_id,(int)f->goaway.error_code,NULL,0);
    return 0;
}
static void drop_body(Peer *peer,int stream){Body **p=&peer->bodies;while(*p){if((*p)->stream==stream){Body *b=*p;*p=b->next;while(b->first){Chunk *chunk=b->first;b->first=chunk->next;release(chunk,NULL);}release(b,NULL);return;}p=&(*p)->next;}}
static int closed(nghttp2_session *s,int32_t stream,uint32_t code,void *u){Peer *peer=u;(void)s;(void)u;drop_body(peer,stream);return emit(peer,4,stream,(int)code,NULL,0);}
static int body_eof(Peer *peer,Body *body,uint32_t *flags){
    *flags|=NGHTTP2_DATA_FLAG_EOF;
    if(body->wait_trailers){
        *flags|=NGHTTP2_DATA_FLAG_NO_END_STREAM;
        if(!body->want_trailers){body->want_trailers=1;return emit(peer,6,body->stream,0,NULL,0);}
    }
    return 0;
}
static nghttp2_ssize read_body(nghttp2_session *s,int32_t stream,uint8_t *out,size_t length,uint32_t *flags,nghttp2_data_source *source,void *u){
    (void)s;(void)stream;Peer *peer=u;Body *body=source->ptr;
    if(!body->first){if(body->ended)return body_eof(peer,body,flags);body->deferred=1;return NGHTTP2_ERR_DEFERRED;}
    Chunk *chunk=body->first;size_t remaining=chunk->length-chunk->offset;if(length>remaining)length=remaining;
    memcpy(out,chunk->bytes+chunk->offset,length);chunk->offset+=length;body->queued-=length;
    if(chunk->offset==chunk->length){body->first=chunk->next;if(!body->first)body->last=NULL;release(chunk,NULL);}
    if(!body->first&&body->ended){int result=body_eof(peer,body,flags);if(result)return result;}return (nghttp2_ssize)length;
}
static void peer_close(Peer *peer){
    if(peer->session)nghttp2_session_del(peer->session);peer->session=NULL;
    while(peer->bodies)drop_body(peer,peer->bodies->stream);while(peer->first)peer_pop(peer);
    while(peer->credits){Credit *credit=peer->credits;peer->credits=credit->next;release(credit,NULL);}
    peer->pending=NULL;peer->pending_length=peer->pending_offset=0;
}
static int peer_init(Peer *peer,int server){
    if(peer->session||(server!=0&&server!=1))return NGHTTP2_ERR_INVALID_ARGUMENT;
    nghttp2_session_callbacks *callbacks=NULL;int result=nghttp2_session_callbacks_new(&callbacks);if(result)return result;
    nghttp2_session_callbacks_set_on_begin_headers_callback(callbacks,begin_headers);
    nghttp2_session_callbacks_set_on_header_callback(callbacks,header);
    nghttp2_session_callbacks_set_on_data_chunk_recv_callback(callbacks,data);
    nghttp2_session_callbacks_set_on_frame_recv_callback(callbacks,frame);
    nghttp2_session_callbacks_set_on_stream_close_callback(callbacks,closed);
    nghttp2_mem memory={NULL,reserve,release,zeroed,resize};nghttp2_option *options=NULL;
    result=nghttp2_option_new(&options);
    if(!result){nghttp2_option_set_no_auto_window_update(options,1);result=server?nghttp2_session_server_new3(&peer->session,callbacks,peer,options,&memory):nghttp2_session_client_new3(&peer->session,callbacks,peer,options,&memory);}
    nghttp2_option_del(options);
    nghttp2_session_callbacks_del(callbacks);
    if(!result){nghttp2_settings_entry settings[]={{NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS,16},{NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,65536}};result=nghttp2_submit_settings(peer->session,NGHTTP2_FLAG_NONE,settings,2);}
    if(result)peer_close(peer);return result;
}
static Body *body_new(Peer *peer,int stream,const void *bytes,int length,int ended){
    if(length<0||length>1048576)return NULL;Body *body=reserve(sizeof(Body),NULL);if(!body)return NULL;
    *body=(Body){.next=peer->bodies,.stream=stream,.ended=ended,.queued=(size_t)length};
    if(length){Chunk *chunk=reserve(sizeof(Chunk)+(size_t)length,NULL);if(!chunk){release(body,NULL);return NULL;}*chunk=(Chunk){.length=(size_t)length};memcpy(chunk->bytes,bytes,(size_t)length);body->first=body->last=chunk;}
    peer->bodies=body;return body;
}
#define NV(name,value) {(uint8_t *)(name),(uint8_t *)(value),strlen(name),strlen(value),NGHTTP2_NV_FLAG_NONE}
static int request(Peer *peer,const char *method,const char *path,const char *authority,const void *bytes,int length,int ended){
    if(!peer->session||!method||!path||!authority||strlen(method)>32||strlen(path)>8192||strlen(authority)>255)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=body_new(peer,-1,bytes,length,ended);if(!body)return NGHTTP2_ERR_NOMEM;
    nghttp2_nv headers[]={NV(":method",method),NV(":scheme","http"),NV(":authority",authority),NV(":path",path)};
    nghttp2_data_provider2 provider={.source.ptr=body,.read_callback=read_body};
    int stream=nghttp2_submit_request2(peer->session,NULL,headers,4,&provider,NULL);
    if(stream<0)drop_body(peer,-1);else body->stream=stream;return stream;
}
static int peer_request(Peer *peer,const char *method,const char *path,const char *authority,const void *bytes,int length){return request(peer,method,path,authority,bytes,length,1);}
static int peer_request_start(Peer *peer,const char *method,const char *path,const char *authority){return request(peer,method,path,authority,NULL,0,0);}
static int response(Peer *peer,int stream,const char *status,const void *bytes,int length,int ended){
    if(!peer->session||!status||strlen(status)!=3)return NGHTTP2_ERR_INVALID_ARGUMENT;
    for(Body *b=peer->bodies;b;b=b->next)if(b->stream==stream)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=body_new(peer,stream,bytes,length,ended);if(!body)return NGHTTP2_ERR_NOMEM;
    nghttp2_nv headers[]={NV(":status",status),NV("content-type","application/octet-stream")};
    nghttp2_data_provider2 provider={.source.ptr=body,.read_callback=read_body};
    int result=nghttp2_submit_response2(peer->session,stream,headers,2,&provider);if(result)drop_body(peer,stream);return result;
}
static int peer_response(Peer *peer,int stream,const char *status,const void *bytes,int length){return response(peer,stream,status,bytes,length,1);}
static int peer_response_start(Peer *peer,int stream,const char *status){return response(peer,stream,status,NULL,0,0);}
static int peer_write(Peer *peer,int stream,const void *bytes,int length,int end){
    if(!peer->session||length<0||length>65536||(end!=0&&end!=1))return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=peer->bodies;while(body&&body->stream!=stream)body=body->next;
    if(!body||body->ended)return NGHTTP2_ERR_INVALID_ARGUMENT;
    int accepted=length;size_t available=body->queued>=65536?0:65536-body->queued;if((size_t)accepted>available)accepted=(int)available;
    if(length&&!accepted)return 0;
    Chunk *chunk=NULL;
    if(accepted){chunk=reserve(sizeof(Chunk)+(size_t)accepted,NULL);if(!chunk)return NGHTTP2_ERR_NOMEM;*chunk=(Chunk){.length=(size_t)accepted};memcpy(chunk->bytes,bytes,(size_t)accepted);}
    if(body->deferred&&(accepted||end)){int result=nghttp2_session_resume_data(peer->session,stream);if(result){release(chunk,NULL);return result;}body->deferred=0;}
    if(chunk){if(body->last)body->last->next=chunk;else body->first=chunk;body->last=chunk;body->queued+=(size_t)accepted;}
    if(end&&accepted==length)body->ended=1;return accepted;
}
static int peer_queued(Peer *peer,int stream){Body *body=peer->bodies;while(body&&body->stream!=stream)body=body->next;return body?(int)body->queued:NGHTTP2_ERR_INVALID_ARGUMENT;}
static int peer_consume(Peer *peer,int stream,int length){
    if(!peer->session||stream<=0||length<0)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Credit **p=&peer->credits;while(*p&&(*p)->stream!=stream)p=&(*p)->next;
    if(!*p||(size_t)length>(*p)->pending)return NGHTTP2_ERR_INVALID_ARGUMENT;
    int result=nghttp2_session_consume(peer->session,stream,(size_t)length);if(result)return result;
    (*p)->pending-=(size_t)length;if(!(*p)->pending){Credit *credit=*p;*p=credit->next;release(credit,NULL);}return 0;
}
static int peer_feed(Peer *peer,const uint8_t *bytes,int length){if(!peer->session||length<0||length>65536)return NGHTTP2_ERR_INVALID_ARGUMENT;return (int)nghttp2_session_mem_recv2(peer->session,bytes,(size_t)length);}
static int peer_send(Peer *peer,uint8_t *bytes,int length){
    if(!peer->session||length<=0||length>65536)return NGHTTP2_ERR_INVALID_ARGUMENT;
    if(peer->pending_offset==peer->pending_length){nghttp2_ssize n=nghttp2_session_mem_send2(peer->session,&peer->pending);if(n<=0)return (int)n;peer->pending_length=(size_t)n;peer->pending_offset=0;}
    size_t remaining=peer->pending_length-peer->pending_offset;if((size_t)length>remaining)length=(int)remaining;memcpy(bytes,peer->pending+peer->pending_offset,(size_t)length);peer->pending_offset+=(size_t)length;return length;
}
static int peer_reset(Peer *peer,int stream,int code){return peer->session?nghttp2_submit_rst_stream(peer->session,0,stream,(uint32_t)code):NGHTTP2_ERR_INVALID_ARGUMENT;}
void *h2_allocate(int length){return length>=0?reserve((size_t)length,NULL):NULL;}
void h2_free(void *pointer){release(pointer,NULL);}
int h2_allocated(void){return (int)live;}
int h2_peak(void){return (int)peak;}
const char *h2_error(int code){return nghttp2_strerror(code);}

int h2_initialize(int maximum,int maximum_sessions){
    if(initialized||live||maximum<65536||maximum>32*1024*1024||maximum_sessions<1||maximum_sessions>32)return NGHTTP2_ERR_INVALID_ARGUMENT;
    budget=(size_t)maximum;peak=0;session_limit=maximum_sessions;initialized=1;return 0;
}
int h2_open(int server){
    if(!initialized||(server!=0&&server!=1)||next_id>=2147483647)return NGHTTP2_ERR_INVALID_ARGUMENT;
    int slot=0;while(slot<session_limit&&peers[slot])slot++;if(slot==session_limit)return NGHTTP2_ERR_NOMEM;
    Peer *peer=zeroed(1,sizeof(Peer),NULL);if(!peer)return NGHTTP2_ERR_NOMEM;
    int result=peer_init(peer,server);
    if(result){peer_close(peer);release(peer,NULL);return result;}
    peer->id=next_id++;peers[slot]=peer;return peer->id;
}
int h2_destroy(int id){
    for(int i=0;i<32;i++)if(peers[i]&&peers[i]->id==id){
        Peer *peer=peers[i];peers[i]=NULL;peer_close(peer);release(peer,NULL);return 0;
    }
    return NGHTTP2_ERR_INVALID_ARGUMENT;
}
int h2_shutdown(void){
    for(int i=0;i<32;i++)if(peers[i])h2_destroy(peers[i]->id);
    initialized=0;session_limit=0;return (int)live;
}
int h2_count(void){int count=0;for(int i=0;i<32;i++)if(peers[i])count++;return count;}
int h2_goaway(int id,int code){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return nghttp2_submit_goaway(peer->session,0,nghttp2_session_get_last_proc_stream_id(peer->session),(uint32_t)code,NULL,0);}
static int submit_headers(int id,int stream,const uint8_t *bytes,int length,int end,int wait_trailers,int trailers){
    Peer *peer=lookup(id);if(!peer||stream<0||length<(trailers?0:1)||length>65536||(end!=0&&end!=1)||(wait_trailers!=0&&wait_trailers!=1))return NGHTTP2_ERR_INVALID_ARGUMENT;
    nghttp2_nv headers[128];size_t count=0,offset=0;
    while(offset<(size_t)length){
        if(count==128)return NGHTTP2_ERR_INVALID_ARGUMENT;
        const uint8_t *name=bytes+offset,*name_end=memchr(name,0,(size_t)length-offset);
        if(!name_end||name_end==name)return NGHTTP2_ERR_INVALID_ARGUMENT;
        offset=(size_t)(name_end-bytes)+1;
        const uint8_t *value=bytes+offset,*value_end=memchr(value,0,(size_t)length-offset);
        if(!value_end)return NGHTTP2_ERR_INVALID_ARGUMENT;
        headers[count++]=(nghttp2_nv){(uint8_t *)name,(uint8_t *)value,(size_t)(name_end-name),(size_t)(value_end-value),NGHTTP2_NV_FLAG_NONE};
        offset=(size_t)(value_end-bytes)+1;
    }
    if(trailers){
        Body *body=peer->bodies;while(body&&body->stream!=stream)body=body->next;
        if(!body||!body->want_trailers||body->sent_trailers)return NGHTTP2_ERR_INVALID_ARGUMENT;
        for(size_t i=0;i<count;i++)if(headers[i].name[0]==':')return NGHTTP2_ERR_INVALID_ARGUMENT;
        int result=nghttp2_submit_trailer(peer->session,stream,headers,count);
        if(!result)body->sent_trailers=1;
        return result;
    }
    if(stream)for(Body *b=peer->bodies;b;b=b->next)if(b->stream==stream)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=end?NULL:body_new(peer,stream?stream:-1,NULL,0,0);
    if(!end&&!body)return NGHTTP2_ERR_NOMEM;
    if(body)body->wait_trailers=wait_trailers;
    nghttp2_data_provider2 provider={.source.ptr=body,.read_callback=read_body};
    int result=stream?nghttp2_submit_response2(peer->session,stream,headers,count,end?NULL:&provider):nghttp2_submit_request2(peer->session,NULL,headers,count,end?NULL:&provider,NULL);
    if(body){if(result<0)drop_body(peer,body->stream);else if(!stream)body->stream=result;}
    return result;
}
int h2_headers(int id,int stream,const uint8_t *bytes,int length,int end,int wait_trailers){return submit_headers(id,stream,bytes,length,end,wait_trailers,0);}
int h2_trailers(int id,int stream,const uint8_t *bytes,int length){return submit_headers(id,stream,bytes,length,0,0,1);}
int h2_pop(int id){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;peer_pop(peer);return 0;}
int h2_event_type(int id){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_event_type(peer);}
int h2_event_stream(int id){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_event_stream(peer);}
int h2_event_flags(int id){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_event_flags(peer);}
int h2_event_length(int id){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_event_length(peer);}
const void * h2_event_data(int id){Peer *peer=lookup(id);if(!peer)return NULL;return peer_event_data(peer);}
int h2_request(int id,const char *method,const char *path,const char *authority,const void *bytes,int length){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_request(peer,method,path,authority,bytes,length);}
int h2_request_start(int id,const char *method,const char *path,const char *authority){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_request_start(peer,method,path,authority);}
int h2_response(int id,int stream,const char *status,const void *bytes,int length){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_response(peer,stream,status,bytes,length);}
int h2_response_start(int id,int stream,const char *status){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_response_start(peer,stream,status);}
int h2_write(int id,int stream,const void *bytes,int length,int end){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_write(peer,stream,bytes,length,end);}
int h2_queued(int id,int stream){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_queued(peer,stream);}
int h2_consume(int id,int stream,int length){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_consume(peer,stream,length);}
int h2_feed(int id,const uint8_t *bytes,int length){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_feed(peer,bytes,length);}
int h2_send(int id,uint8_t *bytes,int length){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_send(peer,bytes,length);}
int h2_reset(int id,int stream,int code){Peer *peer=lookup(id);if(!peer)return NGHTTP2_ERR_INVALID_ARGUMENT;return peer_reset(peer,stream,code);}
