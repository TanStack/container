#include "wasm3.h"
#include "m3_env.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Test adapter, not the public guest WebAssembly API. One owned runtime at a time. */
static IM3Environment environment;
static IM3Runtime runtime;
static IM3Module module;
static uint8_t *source;
static char error_text[512];
static int32_t answer;

static int fail(M3Result error) {
    if (!error) return 0;
    strncpy(error_text, error, sizeof(error_text) - 1);
    error_text[sizeof(error_text) - 1] = 0;
    return 1;
}

void probe_close(void) {
    if (runtime) m3_FreeRuntime(runtime);
    if (environment) m3_FreeEnvironment(environment);
    free(source);
    runtime = NULL; environment = NULL; module = NULL; source = NULL;
}

m3ApiRawFunction(host_twice) {
    m3ApiReturnType(int32_t)
    m3ApiGetArg(int32_t, value)
    m3ApiReturn((int32_t)((uint32_t)value * 2));
}

int probe_open(const uint8_t *bytes, uint32_t length, double gas, int imports) {
    probe_close(); error_text[0] = 0;
    if (!bytes || !length || length > 8 * 1024 * 1024) return fail("Invalid module input");
    source = malloc(length);
    if (!source) return fail("Module source allocation failed");
    memcpy(source, bytes, length);
    environment = m3_NewEnvironment();
    if (!environment) return fail("Environment allocation failed");
    runtime = m3_NewRuntime(environment, 64 * 1024, NULL);
    if (!runtime) return fail("Runtime allocation failed");
    /* Meter before loading or compiling any guest function. */
    m3_SetGasLimit(runtime, gas);
    if (fail(m3_ParseModule(environment, &module, source, length))) return 1;
    /* Load takes ownership even on failure. Parse frees its own failed output. */
    if (fail(m3_LoadModule(runtime, module))) return 1;
    if (imports && fail(m3_LinkRawFunction(module, "host", "twice", "i(i)", host_twice))) return 1;
    if (fail(m3_CompileModule(module))) return 1;
    return fail(m3_RunStart(module));
}

int probe_call(const char *name, int count, int32_t value) {
    error_text[0] = 0; answer = 0;
    if (!runtime || !module || count < 0 || count > 1) return fail("Invalid call");
    IM3Function function;
    if (fail(m3_FindFunctionIn(&function, module, name))) return 1;
    if (m3_GetArgCount(function) != (uint32_t)count || m3_GetRetCount(function) > 1)
        return fail("Unsupported probe signature");
    if ((count && m3_GetArgType(function, 0) != c_m3Type_i32) ||
        (m3_GetRetCount(function) && m3_GetRetType(function, 0) != c_m3Type_i32))
        return fail("Unsupported probe value type");
    const void *args[] = { &value };
    if (fail(m3_Call(function, count, args))) return 1;
    if (m3_GetRetCount(function) && fail(m3_GetResultsV(function, &answer))) return 1;
    return 0;
}

int32_t probe_answer(void) { return answer; }
const char *probe_error(void) { return error_text; }
void probe_budget(double gas) { if (runtime) m3_SetGasLimit(runtime, gas); }
double probe_used(void) { return runtime ? m3_GetGasUsed(runtime) : 0; }
uint32_t probe_frames(void) { return runtime ? runtime->activeFrames : 0; }
uint8_t *probe_memory(void) { return module ? m3_GetMemory(module, NULL, 0) : NULL; }
uint32_t probe_memory_size(void) { return module ? (uint32_t)m3_GetMemorySize(module, 0) : 0; }
