#include <assert.h>
#include <stdio.h>
#include "../src/sandbox/http2-probe.c"

int main(void) {
    unsigned char wire[16384], output[16384], body[262144];
    memset(body, 97, sizeof(body));
    assert(h2_init(0, 1048576) == 0);
    assert(h2_request("POST", "/native", "localhost", body, 23) == 1);
    int length = 0, n;
    while ((n = h2_send(wire + length, (int)sizeof(wire) - length)) > 0) length += n;
    assert(n == 0 && length > 24);
    assert(h2_close() == 0);
    int successes = 0, failures = 0, cycles = 0;
    for (int maximum = 65536; maximum <= 1048576; maximum += 4096) {
        int result = h2_init(1, maximum);
        if (!result) {
            for (int offset = 0; offset < length && result >= 0; offset++) {
                result = h2_feed(wire + offset, 1);
                while (h2_event_type()) h2_pop();
            }
            if (result >= 0) result = h2_response(1, "200", body, sizeof(body));
            if (result >= 0) {
                while ((n = h2_send(output, sizeof(output))) > 0) {
                    while (h2_event_type()) h2_pop();
                }
                result = n;
            }
        }
        if (result < 0) failures++; else successes++;
        assert(h2_peak() <= maximum);
        assert(h2_close() == 0);
        // Every failed or successful attempt must permit a fresh live session.
        assert(h2_init(0, 1048576) == 0);
        assert(h2_request("POST", "/recovered", "localhost", body, 23) == 1);
        assert(h2_close() == 0);
        cycles++;
    }
    int streaming_successes = 0, streaming_failures = 0;
    for (int maximum = 65536; maximum <= 1048576; maximum += 4096) {
        int result = h2_init(0, maximum);
        if (!result) {
            int stream = h2_request_start("POST", "/stream", "localhost");
            result = stream;
            if (stream > 0) {
                // No body yet: the provider must defer, not send END_STREAM.
                while ((n = h2_send(output, sizeof(output))) > 0) {}
                result = n;
                if (!result) assert(bodies && bodies->deferred && !bodies->ended);
                for (int chunk = 0; chunk < 20 && result >= 0; chunk++) {
                    result = h2_write(stream, body, 23, 0);
                    if (result >= 0) {
                        assert(result == 23);
                        while ((n = h2_send(output, sizeof(output))) > 0) {}
                        result = n;
                        if (!result) assert(h2_queued(stream) == 0 && bodies->deferred);
                    }
                }
                if (result >= 0) result = h2_write(stream, body, 65536, 0);
                if (result >= 0) {
                    assert(result == 65536);
                    assert(h2_write(stream, body, 1, 1) == 0);
                    assert(!bodies->ended);
                    result = h2_reset(stream, NGHTTP2_CANCEL);
                    if (!result) {
                        while ((n = h2_send(output, sizeof(output))) > 0) {}
                        result = n;
                        if (!result) assert(h2_write(stream, body, 1, 0) < 0);
                    }
                }
            }
        }
        if (result < 0) streaming_failures++; else streaming_successes++;
        assert(h2_peak() <= maximum);
        assert(h2_close() == 0);
        assert(h2_init(0, 1048576) == 0);
        assert(h2_request_start("POST", "/end", "localhost") == 1);
        assert(h2_write(1, NULL, 0, 1) == 0);
        assert(h2_write(1, body, 1, 0) < 0);
        assert(h2_close() == 0);
    }
    assert(streaming_successes > 0 && streaming_failures > 0);
    assert(h2_init(1, 1048576) == 0);
    assert(h2_feed((const unsigned char *)"invalid connection preface", 26) < 0);
    assert(h2_close() == 0);
    assert(successes > 0 && failures > 0);
    printf("{\"cycles\":%d,\"successes\":%d,\"failures\":%d,\"streamingCycles\":%d,\"streamingSuccesses\":%d,\"streamingFailures\":%d,\"remainingBytes\":%d}\n", cycles, successes, failures, streaming_successes + streaming_failures, streaming_successes, streaming_failures, h2_allocated());
    return 0;
}
