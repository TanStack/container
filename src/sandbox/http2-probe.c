#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <nghttp2/nghttp2.h>

/* Protocol spike: one peer per module, no OS sockets or guest access yet. */
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
typedef struct Body {struct Body *next;int stream,ended,deferred;size_t queued;Chunk *first,*last;} Body;
typedef struct Credit {struct Credit *next;int stream;size_t pending;} Credit;
static nghttp2_session *session;
static Event *first,*last;
static Body *bodies;
static Credit *credits;
static size_t event_bytes,event_count,header_bytes,header_count;
static const uint8_t *pending;static size_t pending_length,pending_offset;
static int emit(int type,int stream,int flags,const void *bytes,size_t length){
    if(event_count>=256||length>262144-event_bytes)return NGHTTP2_ERR_CALLBACK_FAILURE;
    Event *event=reserve(sizeof(Event)+length,NULL);if(!event)return NGHTTP2_ERR_CALLBACK_FAILURE;
    *event=(Event){.type=type,.stream=stream,.flags=flags,.length=length};if(length)memcpy(event->bytes,bytes,length);
    if(last)last->next=event;else first=event;last=event;event_count++;event_bytes+=length;return 0;
}
void h2_pop(void){if(!first)return;Event *event=first;first=event->next;if(!first)last=NULL;event_count--;event_bytes-=event->length;release(event,NULL);}
int h2_event_type(void){return first?first->type:0;}
int h2_event_stream(void){return first?first->stream:0;}
int h2_event_flags(void){return first?first->flags:0;}
int h2_event_length(void){return first?(int)first->length:0;}
const void *h2_event_data(void){return first?first->bytes:NULL;}
static int begin_headers(nghttp2_session *s,const nghttp2_frame *f,void *u){(void)s;(void)f;(void)u;header_bytes=header_count=0;return 0;}
static int header(nghttp2_session *s,const nghttp2_frame *f,const uint8_t *name,size_t n,const uint8_t *value,size_t v,uint8_t flags,void *u){
    (void)s;(void)flags;(void)u;if(++header_count>128||n>65536-header_bytes||v>65536-header_bytes-n)return NGHTTP2_ERR_TEMPORAL_CALLBACK_FAILURE;
    header_bytes+=n+v;unsigned char *joined=reserve(n+v+1,NULL);if(!joined)return NGHTTP2_ERR_CALLBACK_FAILURE;
    memcpy(joined,name,n);joined[n]=0;memcpy(joined+n+1,value,v);int result=emit(1,f->hd.stream_id,0,joined,n+v+1);release(joined,NULL);return result;
}
static int data(nghttp2_session *s,uint8_t flags,int32_t stream,const uint8_t *bytes,size_t length,void *u){
    (void)s;(void)u;if(!length)return 0;
    Credit *credit=credits;while(credit&&credit->stream!=stream)credit=credit->next;
    if(!credit){credit=reserve(sizeof(Credit),NULL);if(!credit)return NGHTTP2_ERR_CALLBACK_FAILURE;*credit=(Credit){.next=credits,.stream=stream};credits=credit;}
    int result=emit(2,stream,flags,bytes,length);if(!result)credit->pending+=length;return result;
}
static int frame(nghttp2_session *s,const nghttp2_frame *f,void *u){
    (void)s;(void)u;if(f->hd.type==NGHTTP2_HEADERS||f->hd.type==NGHTTP2_DATA)return emit(3,f->hd.stream_id,f->hd.flags,NULL,0);
    if(f->hd.type==NGHTTP2_GOAWAY)return emit(5,f->goaway.last_stream_id,(int)f->goaway.error_code,NULL,0);
    return 0;
}
static void drop_body(int stream){Body **p=&bodies;while(*p){if((*p)->stream==stream){Body *b=*p;*p=b->next;while(b->first){Chunk *chunk=b->first;b->first=chunk->next;release(chunk,NULL);}release(b,NULL);return;}p=&(*p)->next;}}
static int closed(nghttp2_session *s,int32_t stream,uint32_t code,void *u){(void)s;(void)u;drop_body(stream);return emit(4,stream,(int)code,NULL,0);}
static nghttp2_ssize read_body(nghttp2_session *s,int32_t stream,uint8_t *out,size_t length,uint32_t *flags,nghttp2_data_source *source,void *u){
    (void)s;(void)stream;(void)u;Body *body=source->ptr;
    if(!body->first){if(body->ended){*flags|=NGHTTP2_DATA_FLAG_EOF;return 0;}body->deferred=1;return NGHTTP2_ERR_DEFERRED;}
    Chunk *chunk=body->first;size_t remaining=chunk->length-chunk->offset;if(length>remaining)length=remaining;
    memcpy(out,chunk->bytes+chunk->offset,length);chunk->offset+=length;body->queued-=length;
    if(chunk->offset==chunk->length){body->first=chunk->next;if(!body->first)body->last=NULL;release(chunk,NULL);}
    if(!body->first&&body->ended)*flags|=NGHTTP2_DATA_FLAG_EOF;return (nghttp2_ssize)length;
}
int h2_close(void){
    if(session)nghttp2_session_del(session);session=NULL;
    while(bodies)drop_body(bodies->stream);while(first)h2_pop();
    while(credits){Credit *credit=credits;credits=credit->next;release(credit,NULL);}
    pending=NULL;pending_length=pending_offset=0;return (int)live;
}
int h2_init(int server,int maximum){
    if(session||live||maximum<65536||maximum>32*1024*1024||(server!=0&&server!=1))return NGHTTP2_ERR_INVALID_ARGUMENT;
    budget=(size_t)maximum;peak=0;nghttp2_session_callbacks *callbacks=NULL;int result=nghttp2_session_callbacks_new(&callbacks);if(result)return result;
    nghttp2_session_callbacks_set_on_begin_headers_callback(callbacks,begin_headers);
    nghttp2_session_callbacks_set_on_header_callback(callbacks,header);
    nghttp2_session_callbacks_set_on_data_chunk_recv_callback(callbacks,data);
    nghttp2_session_callbacks_set_on_frame_recv_callback(callbacks,frame);
    nghttp2_session_callbacks_set_on_stream_close_callback(callbacks,closed);
    nghttp2_mem memory={NULL,reserve,release,zeroed,resize};nghttp2_option *options=NULL;
    result=nghttp2_option_new(&options);
    if(!result){nghttp2_option_set_no_auto_window_update(options,1);result=server?nghttp2_session_server_new3(&session,callbacks,NULL,options,&memory):nghttp2_session_client_new3(&session,callbacks,NULL,options,&memory);}
    nghttp2_option_del(options);
    nghttp2_session_callbacks_del(callbacks);
    if(!result){nghttp2_settings_entry settings[]={{NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS,16},{NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,65536}};result=nghttp2_submit_settings(session,NGHTTP2_FLAG_NONE,settings,2);}
    if(result)h2_close();return result;
}
static Body *body_new(int stream,const void *bytes,int length,int ended){
    if(length<0||length>1048576)return NULL;Body *body=reserve(sizeof(Body),NULL);if(!body)return NULL;
    *body=(Body){.next=bodies,.stream=stream,.ended=ended,.queued=(size_t)length};
    if(length){Chunk *chunk=reserve(sizeof(Chunk)+(size_t)length,NULL);if(!chunk){release(body,NULL);return NULL;}*chunk=(Chunk){.length=(size_t)length};memcpy(chunk->bytes,bytes,(size_t)length);body->first=body->last=chunk;}
    bodies=body;return body;
}
#define NV(name,value) {(uint8_t *)(name),(uint8_t *)(value),strlen(name),strlen(value),NGHTTP2_NV_FLAG_NONE}
static int request(const char *method,const char *path,const char *authority,const void *bytes,int length,int ended){
    if(!session||!method||!path||!authority||strlen(method)>32||strlen(path)>8192||strlen(authority)>255)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=body_new(-1,bytes,length,ended);if(!body)return NGHTTP2_ERR_NOMEM;
    nghttp2_nv headers[]={NV(":method",method),NV(":scheme","http"),NV(":authority",authority),NV(":path",path)};
    nghttp2_data_provider2 provider={.source.ptr=body,.read_callback=read_body};
    int stream=nghttp2_submit_request2(session,NULL,headers,4,&provider,NULL);
    if(stream<0)drop_body(-1);else body->stream=stream;return stream;
}
int h2_request(const char *method,const char *path,const char *authority,const void *bytes,int length){return request(method,path,authority,bytes,length,1);}
int h2_request_start(const char *method,const char *path,const char *authority){return request(method,path,authority,NULL,0,0);}
static int response(int stream,const char *status,const void *bytes,int length,int ended){
    if(!session||!status||strlen(status)!=3)return NGHTTP2_ERR_INVALID_ARGUMENT;
    for(Body *b=bodies;b;b=b->next)if(b->stream==stream)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=body_new(stream,bytes,length,ended);if(!body)return NGHTTP2_ERR_NOMEM;
    nghttp2_nv headers[]={NV(":status",status),NV("content-type","application/octet-stream")};
    nghttp2_data_provider2 provider={.source.ptr=body,.read_callback=read_body};
    int result=nghttp2_submit_response2(session,stream,headers,2,&provider);if(result)drop_body(stream);return result;
}
int h2_response(int stream,const char *status,const void *bytes,int length){return response(stream,status,bytes,length,1);}
int h2_response_start(int stream,const char *status){return response(stream,status,NULL,0,0);}
int h2_write(int stream,const void *bytes,int length,int end){
    if(!session||length<0||length>65536||(end!=0&&end!=1))return NGHTTP2_ERR_INVALID_ARGUMENT;
    Body *body=bodies;while(body&&body->stream!=stream)body=body->next;
    if(!body||body->ended)return NGHTTP2_ERR_INVALID_ARGUMENT;
    int accepted=length;size_t available=body->queued>=65536?0:65536-body->queued;if((size_t)accepted>available)accepted=(int)available;
    if(length&&!accepted)return 0;
    Chunk *chunk=NULL;
    if(accepted){chunk=reserve(sizeof(Chunk)+(size_t)accepted,NULL);if(!chunk)return NGHTTP2_ERR_NOMEM;*chunk=(Chunk){.length=(size_t)accepted};memcpy(chunk->bytes,bytes,(size_t)accepted);}
    if(body->deferred&&(accepted||end)){int result=nghttp2_session_resume_data(session,stream);if(result){release(chunk,NULL);return result;}body->deferred=0;}
    if(chunk){if(body->last)body->last->next=chunk;else body->first=chunk;body->last=chunk;body->queued+=(size_t)accepted;}
    if(end&&accepted==length)body->ended=1;return accepted;
}
int h2_queued(int stream){Body *body=bodies;while(body&&body->stream!=stream)body=body->next;return body?(int)body->queued:NGHTTP2_ERR_INVALID_ARGUMENT;}
int h2_consume(int stream,int length){
    if(!session||stream<=0||length<0)return NGHTTP2_ERR_INVALID_ARGUMENT;
    Credit **p=&credits;while(*p&&(*p)->stream!=stream)p=&(*p)->next;
    if(!*p||(size_t)length>(*p)->pending)return NGHTTP2_ERR_INVALID_ARGUMENT;
    int result=nghttp2_session_consume(session,stream,(size_t)length);if(result)return result;
    (*p)->pending-=(size_t)length;if(!(*p)->pending){Credit *credit=*p;*p=credit->next;release(credit,NULL);}return 0;
}
int h2_feed(const uint8_t *bytes,int length){if(!session||length<0||length>65536)return NGHTTP2_ERR_INVALID_ARGUMENT;return (int)nghttp2_session_mem_recv2(session,bytes,(size_t)length);}
int h2_send(uint8_t *bytes,int length){
    if(!session||length<=0||length>65536)return NGHTTP2_ERR_INVALID_ARGUMENT;
    if(pending_offset==pending_length){nghttp2_ssize n=nghttp2_session_mem_send2(session,&pending);if(n<=0)return (int)n;pending_length=(size_t)n;pending_offset=0;}
    size_t remaining=pending_length-pending_offset;if((size_t)length>remaining)length=(int)remaining;memcpy(bytes,pending+pending_offset,(size_t)length);pending_offset+=(size_t)length;return length;
}
int h2_reset(int stream,int code){return session?nghttp2_submit_rst_stream(session,0,stream,(uint32_t)code):NGHTTP2_ERR_INVALID_ARGUMENT;}
void *h2_allocate(int length){return length>=0?reserve((size_t)length,NULL):NULL;}
void h2_free(void *pointer){release(pointer,NULL);}
int h2_allocated(void){return (int)live;}
int h2_peak(void){return (int)peak;}
const char *h2_error(int code){return nghttp2_strerror(code);}
