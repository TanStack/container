#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int probe_open(const uint8_t *, uint32_t, double, int);
void probe_close(void);
int probe_call(const char *, int, int32_t);
int32_t probe_answer(void);
const char *probe_error(void);
void probe_budget(double);
uint32_t probe_frames(void);

static void require(int condition, const char *name) {
    if (!condition) { fprintf(stderr, "%s: %s\n", name, probe_error()); exit(1); }
}

int main(int argc, char **argv) {
    require(argc == 2, "controls path required");
    FILE *file = fopen(argv[1], "rb");
    require(file != NULL, "open fixture");
    require(fseek(file, 0, SEEK_END) == 0, "seek fixture");
    long length = ftell(file);
    require(length > 0 && length < 1024 * 1024, "fixture size");
    rewind(file);
    uint8_t *original = malloc((size_t)length), *mutant = malloc((size_t)length);
    require(original && mutant, "fixture allocation");
    require(fread(original, 1, (size_t)length, file) == (size_t)length, "read fixture");
    fclose(file);
    require(!probe_open(original, (uint32_t)length, 1000, 0), "unmodified controls");
    probe_close();
    unsigned accepted = 0, rejected = 0;
    for (long offset = 0; offset < length; offset++) for (int bit = 0; bit < 8; bit++) {
        memcpy(mutant, original, (size_t)length); mutant[offset] ^= 1u << bit;
        if (probe_open(mutant, (uint32_t)length, 1000, 0)) rejected++; else accepted++;
        probe_close();
    }
    for (int cycle = 0; cycle < 100; cycle++) {
        require(!probe_open(original, (uint32_t)length, 1000, 0), "open controls");
        const char *traps[] = {"loop", "recurse", "indirect", "loopTail", "oob", "unreachable"};
        for (unsigned i = 0; i < sizeof(traps) / sizeof(traps[0]); i++) {
            probe_budget(i == 0 ? 1000 : 1000000);
            require(probe_call(traps[i], 0, 0), "expected trap");
            require(probe_frames() == 0, "frame cleanup");
            probe_budget(10000000);
            require(!probe_call("answer", 0, 0) && probe_answer() == 42, "recovery");
        }
        probe_close();
    }
    free(mutant); free(original);
    printf("{\"mutations\":%ld,\"accepted\":%u,\"rejected\":%u,\"trapRecoveryCycles\":600}\n", length * 8, accepted, rejected);
    return 0;
}
