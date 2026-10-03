/* Host embed probe: real needle_embed vectors + dim + latency.
 * Links the pinned linux-x86_64 engine. Usage:
 *   embed-probe <needle3.cact> <text...>  (one JSON object per line on stdout)
 * Telemetry is disabled before load (vendor off-switch).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "needle.h"

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static void json_escape(FILE *out, const char *s) {
    fputc('"', out);
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') fputc('\\', out);
        fputc(*s, out);
    }
    fputc('"', out);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: embed-probe <model.cact> <text...>\n");
        return 2;
    }
    setenv("NEEDLE_TELEMETRY", "0", 1);
    setenv("DO_NOT_TRACK", "1", 1);

    FILE *f = fopen(argv[1], "rb");
    if (!f) {
        fprintf(stderr, "cannot open model\n");
        return 1;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    rewind(f);
    unsigned char *bytes = (unsigned char *)malloc(size > 0 ? (size_t)size : 1);
    if (!bytes || (size > 0 && fread(bytes, 1, (size_t)size, f) != (size_t)size)) {
        fprintf(stderr, "cannot read model\n");
        return 1;
    }
    fclose(f);

    double t0 = now_ms();
    if (needle_load(bytes, (unsigned long long)(size > 0 ? size : 0)) < 0) {
        fprintf(stderr, "needle_load failed: %s\n", needle_last_error());
        return 1;
    }
    double load_ms = now_ms() - t0;

    int dim = needle_embed("probe", NULL, 0, NULL, 0);
    if (dim <= 0) {
        fprintf(stderr, "dim probe failed: %s\n", needle_last_error());
        return 1;
    }
    float *out = (float *)malloc(sizeof(float) * (size_t)dim);
    if (!out) return 1;

    for (int i = 2; i < argc; i++) {
        double s = now_ms();
        int rc = needle_embed(argv[i], NULL, 0, out, dim);
        double ms = now_ms() - s;
        if (rc < 0) {
            printf("{\"input\":");
            json_escape(stdout, argv[i]);
            printf(",\"error\":");
            json_escape(stdout, needle_last_error());
            printf("}\n");
            continue;
        }
        double norm = 0.0;
        for (int j = 0; j < dim; j++) norm += (double)out[j] * (double)out[j];
        printf("{\"input\":");
        json_escape(stdout, argv[i]);
        printf(",\"dim\":%d,\"embed_ms\":%.2f,\"l2_norm\":%.4f,\"first\":[%.6f,%.6f,%.6f]}\n",
               dim, ms, norm, out[0], out[1], out[2]);
    }
    printf("{\"load_ms\":%.1f,\"dim\":%d}\n", load_ms, dim);
    free(out);
    return 0;
}
