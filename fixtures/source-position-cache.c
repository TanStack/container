#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* The probe runner inserts the unchanged QuickJS cache here. */
/* ORIGINAL_CACHE */

enum { CHECKPOINTS = 32 };
typedef struct {
    GetLineColCache recent;
    size_t stride;
    unsigned filled;
    int lines[CHECKPOINTS];
    int columns[CHECKPOINTS];
} IndexedCache;

static int indexed_lookup(IndexedCache *s, int *column, const uint8_t *ptr)
{
    size_t offset = ptr - s->recent.buf_start;
    unsigned bucket = offset / s->stride;
    if (bucket >= CHECKPOINTS) bucket = CHECKPOINTS - 1;
    while (s->filled < bucket) {
        unsigned i = s->filled++;
        int col;
        int lines = get_line_col(&col, s->recent.buf_start + i * s->stride, s->stride);
        s->lines[i + 1] = s->lines[i] + lines;
        s->columns[i + 1] = lines ? col : s->columns[i] + col;
    }
    const uint8_t *checkpoint = s->recent.buf_start + bucket * s->stride;
    /* Keep sequential lookups cheap, including repeated source positions. */
    if (s->recent.ptr < checkpoint ||
        (s->recent.ptr > ptr && s->recent.ptr - ptr > ptr - checkpoint)) {
        s->recent.ptr = checkpoint;
        s->recent.line_num = s->lines[bucket];
        s->recent.col_num = s->columns[bucket];
    }
    return get_line_col_cached(&s->recent, column, ptr);
}

static IndexedCache initialize(const uint8_t *buf, size_t len)
{
    IndexedCache s = {0};
    s.recent.ptr = s.recent.buf_start = buf;
    s.stride = len / CHECKPOINTS + 1;
    return s;
}

static uint32_t random_state = 42;
static uint32_t next_random(void)
{
    random_state = random_state * 1664525u + 1013904223u;
    return random_state;
}

int main(void)
{
    const char *patterns[] = {"abcdef", "a\nb\r\nc\r", "é中😀\n", "\n"};
    size_t checks = 0;
    for (unsigned pattern = 0; pattern < 4; pattern++) {
        for (size_t len = 0; len <= 65536; len = len ? len * 2 : 1) {
            uint8_t *buf = malloc(len + 1);
            assert(buf);
            for (size_t i = 0; i < len; i++) buf[i] = patterns[pattern][i % strlen(patterns[pattern])];
            IndexedCache candidate = initialize(buf, len);
            GetLineColCache original = candidate.recent;
            StagedCache staged = {0};
            staged.ptr = staged.buf_start = buf;
            staged.checkpoint_stride = len / 32 + 1;
            for (unsigned i = 0; i < 3000; i++) {
                /* Include both endpoints, reverse jumps and positions inside UTF-8. */
                size_t pos = i % 3 == 0 ? 0 : i % 3 == 1 ? len : next_random() % (len + 1);
                int expected_col, original_col, actual_col;
                int expected = get_line_col(&expected_col, buf, pos);
                int old = get_line_col_cached(&original, &original_col, buf + pos);
                int actual = indexed_lookup(&candidate, &actual_col, buf + pos);
                int staged_col;
                int staged_line = staged_get_line_col_cached(&staged, &staged_col, buf + pos);
                if (expected != actual || expected_col != actual_col || old != actual || original_col != actual_col || staged_line != actual || staged_col != actual_col) {
                    fprintf(stderr, "location mismatch pattern=%u length=%zu position=%zu\n", pattern, len, pos);
                    return 1;
                }
                checks++;
            }
            free(buf);
        }
    }
    size_t len = 1024 * 1024;
    uint8_t *buf = malloc(len);
    assert(buf);
    for (size_t i = 0; i < len; i++) buf[i] = i % 100 == 99 ? '\n' : 'a';
    double seconds[2];
    uint64_t scanned[2];
    volatile unsigned checksum = 0;
    for (unsigned mode = 0; mode < 2; mode++) {
        IndexedCache cache = initialize(buf, len);
        random_state = 42;
        scanned_bytes = 0;
        clock_t start = clock();
        for (unsigned i = 0; i < 5000; i++) {
            size_t pos = next_random() % len;
            int col;
            int line = mode ? indexed_lookup(&cache, &col, buf + pos) : get_line_col_cached(&cache.recent, &col, buf + pos);
            checksum += line + col;
        }
        seconds[mode] = (double)(clock() - start) / CLOCKS_PER_SEC;
        scanned[mode] = scanned_bytes;
    }
    free(buf);
    uint8_t reverse_buffer[65536];
    for (size_t i = 0; i < sizeof(reverse_buffer); i++) reverse_buffer[i] = i % 100 == 99 ? '\n' : 'a';
    uint64_t reverse_scanned[3];
    for (unsigned mode = 0; mode < 3; mode++) {
        IndexedCache cache = initialize(reverse_buffer, sizeof(reverse_buffer));
        StagedCache staged = {0};
        staged.ptr = staged.buf_start = reverse_buffer;
        staged.checkpoint_stride = sizeof(reverse_buffer) / 32 + 1;
        scanned_bytes = 0;
        for (size_t pos = sizeof(reverse_buffer);; pos--) {
            int col;
            int line = mode == 2 ? staged_get_line_col_cached(&staged, &col, reverse_buffer + pos) : mode ? indexed_lookup(&cache, &col, reverse_buffer + pos) : get_line_col_cached(&cache.recent, &col, reverse_buffer + pos);
            assert(line == (int)(pos / 100));
            assert(col == (int)(pos % 100));
            if (!pos) break;
        }
        reverse_scanned[mode] = scanned_bytes;
    }
    /* Checkpoint construction may add one source pass, not repeated bucket scans. */
    assert(reverse_scanned[1] <= reverse_scanned[0] + sizeof(reverse_buffer));
    assert(reverse_scanned[2] == reverse_scanned[1]);
    fprintf(stderr, "Reverse sequential scan bytes: original=%llu indexed=%llu\n", (unsigned long long)reverse_scanned[0], (unsigned long long)reverse_scanned[1]);
    printf("{\"checks\":%zu,\"cacheBytes\":%zu,\"originalCacheBytes\":%zu,\"originalScannedBytes\":%llu,\"indexedScannedBytes\":%llu,\"originalCPUSeconds\":%.6f,\"indexedCPUSeconds\":%.6f,\"checksum\":%u}\n", checks, sizeof(IndexedCache), sizeof(GetLineColCache), (unsigned long long)scanned[0], (unsigned long long)scanned[1], seconds[0], seconds[1], checksum);
}
