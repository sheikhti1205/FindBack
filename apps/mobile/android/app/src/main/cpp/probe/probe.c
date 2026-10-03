/*
 * FindBack capability probes: NNAPI enumeration, Vulkan capability summary,
 * and OpenCL availability — all via dlopen()+dlsym() against OPTIONAL
 * system libraries. Every entry point returns a short ASCII status string;
 * absence of a library, symbol, or device is reported in the string, never
 * as a crash. No privileged APIs, no identifiers, no persistence.
 */
#include <dlfcn.h>
#include <jni.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define FB_BUF 2048

/* Copies src into the running status, sanitising the three field separators
 * this protocol uses (':' ';' '|') so parsers never see a torn record. */
static void append_sanitised(char *dst, size_t dst_len, size_t *pos, const char *src) {
    if (src == NULL) return;
    for (const char *p = src; *p != '\0'; p++) {
        if (*pos + 1 >= dst_len) return;
        char c = *p;
        if (c == ':' || c == ';' || c == '|' || c < ' ' || c > '~') c = '?';
        dst[(*pos)++] = c;
    }
    dst[*pos] = '\0';
}

/* ------------------------------------------------------------------ */
/* NNAPI device enumeration (API 29+; NDK-only, no Java shim).          */
/* ------------------------------------------------------------------ */
typedef struct ANeuralNetworksDevice ANeuralNetworksDevice;
typedef int32_t NNDeviceType;

JNIEXPORT jstring JNICALL
Java_com_findback_app_vlm_NativeProbe_nativeNnapiStatus(JNIEnv *env, jobject thiz) {
    char out[FB_BUF];
    size_t pos = 0;
    out[0] = '\0';

    void *lib = dlopen("libneuralnetworks.so", RTLD_NOW | RTLD_LOCAL);
    if (lib == NULL) {
        snprintf(out, sizeof(out), "unavailable-no-lib");
        return (*env)->NewStringUTF(env, out);
    }

    int (*getDeviceCount)(uint32_t *) = dlsym(lib, "ANeuralNetworks_getDeviceCount");
    int (*getDevice)(uint32_t, ANeuralNetworksDevice **) = dlsym(lib, "ANeuralNetworks_getDevice");
    int (*getName)(const ANeuralNetworksDevice *, const char **) = dlsym(lib, "ANeuralNetworksDevice_getName");
    int (*getType)(const ANeuralNetworksDevice *, int32_t *) = dlsym(lib, "ANeuralNetworksDevice_getType");
    if (getDeviceCount == NULL || getDevice == NULL) {
        dlclose(lib);
        snprintf(out, sizeof(out), "unavailable");
        return (*env)->NewStringUTF(env, out);
    }

    uint32_t count = 0;
    int rc = getDeviceCount(&count);
    if (rc != 0) {
        snprintf(out, sizeof(out), "error:%d", rc);
        dlclose(lib);
        return (*env)->NewStringUTF(env, out);
    }
    pos += (size_t)snprintf(out + pos, sizeof(out) - pos, "supported:%u:", count);
    for (uint32_t i = 0; i < count && pos < sizeof(out) - 8; i++) {
        ANeuralNetworksDevice *dev = NULL;
        if (getDevice(i, &dev) != 0 || dev == NULL) continue;
        const char *name = NULL;
        int32_t type = -1;
        if (getName != NULL) getName(dev, &name);
        if (getType != NULL) getType(dev, &type);
        if (i > 0) {
            if (pos + 1 >= sizeof(out)) break;
            out[pos++] = ';';
            out[pos] = '\0';
        }
        pos += (size_t)snprintf(out + pos, sizeof(out) - pos, "t%d=", type);
        append_sanitised(out, sizeof(out), &pos, name != NULL ? name : "unknown");
    }
    dlclose(lib);
    return (*env)->NewStringUTF(env, out);
}

/* ------------------------------------------------------------------ */
/* Vulkan capability summary (headless instance, no surface).           */
/* ------------------------------------------------------------------ */
#define VK_SUCCESS 0
#define VK_STRUCTURE_TYPE_APPLICATION_INFO 0
#define VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO 1
#define VK_API_VERSION_1_0 ((1u << 22) | (0u << 12))

typedef struct VkApplicationInfo {
    int32_t sType;
    const void *pNext;
    const char *pApplicationName;
    uint32_t applicationVersion;
    const char *pEngineName;
    uint32_t engineVersion;
    uint32_t apiVersion;
} VkApplicationInfo;

typedef struct VkInstanceCreateInfo {
    int32_t sType;
    const void *pNext;
    uint32_t flags;
    const VkApplicationInfo *pApplicationInfo;
    uint32_t enabledLayerCount;
    const char *const *ppEnabledLayerNames;
    uint32_t enabledExtensionCount;
    const char *const *ppEnabledExtensionNames;
} VkInstanceCreateInfo;

typedef struct VkPhysicalDevice_T *VkPhysicalDevice;
typedef struct VkInstance_T *VkInstance;

typedef struct VkPhysicalDeviceProperties {
    uint32_t apiVersion;
    uint32_t driverVersion;
    uint32_t vendorID;
    uint32_t deviceID;
    int32_t deviceType;
    char deviceName[256];
    uint8_t pipelineCacheUUID[16];
    /* Limits/features omitted: name+version is the capability summary. */
} VkPhysicalDeviceProperties;

JNIEXPORT jstring JNICALL
Java_com_findback_app_vlm_NativeProbe_nativeVulkanStatus(JNIEnv *env, jobject thiz) {
    char out[FB_BUF];
    out[0] = '\0';

    void *lib = dlopen("libvulkan.so", RTLD_NOW | RTLD_LOCAL);
    if (lib == NULL) {
        snprintf(out, sizeof(out), "no-lib");
        return (*env)->NewStringUTF(env, out);
    }
    int (*createInstance)(const VkInstanceCreateInfo *, const void *, VkInstance *) =
        dlsym(lib, "vkCreateInstance");
    int (*enumDevices)(VkInstance, uint32_t *, VkPhysicalDevice *) =
        dlsym(lib, "vkEnumeratePhysicalDevices");
    void (*getProps)(VkPhysicalDevice, VkPhysicalDeviceProperties *) =
        dlsym(lib, "vkGetPhysicalDeviceProperties");
    void (*destroyInstance)(VkInstance, const void *) = dlsym(lib, "vkDestroyInstance");
    if (createInstance == NULL || enumDevices == NULL) {
        dlclose(lib);
        snprintf(out, sizeof(out), "no-lib");
        return (*env)->NewStringUTF(env, out);
    }

    VkApplicationInfo app = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "findback-probe",
        .apiVersion = VK_API_VERSION_1_0,
    };
    VkInstanceCreateInfo ci = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &app,
    };
    VkInstance inst = NULL;
    int rc = createInstance(&ci, NULL, &inst);
    if (rc != VK_SUCCESS || inst == NULL) {
        snprintf(out, sizeof(out), "instance-failed:%d", rc);
        dlclose(lib);
        return (*env)->NewStringUTF(env, out);
    }
    uint32_t count = 0;
    rc = enumDevices(inst, &count, NULL);
    if (rc != VK_SUCCESS || count == 0) {
        if (destroyInstance != NULL) destroyInstance(inst, NULL);
        snprintf(out, sizeof(out), "no-devices");
        dlclose(lib);
        return (*env)->NewStringUTF(env, out);
    }
    VkPhysicalDevice devs[8];
    uint32_t want = count > 8 ? 8 : count;
    rc = enumDevices(inst, &want, devs);
    size_t pos = 0;
    pos += (size_t)snprintf(out + pos, sizeof(out) - pos, "ok:%u:", count);
    if (rc == VK_SUCCESS && getProps != NULL) {
        for (uint32_t i = 0; i < want && pos < sizeof(out) - 8; i++) {
            VkPhysicalDeviceProperties p;
            memset(&p, 0, sizeof(p));
            getProps(devs[i], &p);
            if (i > 0) {
                out[pos++] = ';';
                out[pos] = '\0';
            }
            pos += (size_t)snprintf(
                out + pos, sizeof(out) - pos, "v%u.%u:",
                (p.apiVersion >> 22) & 0x7f, (p.apiVersion >> 12) & 0x3ff);
            append_sanitised(out, sizeof(out), &pos, p.deviceName);
        }
    }
    if (destroyInstance != NULL) destroyInstance(inst, NULL);
    dlclose(lib);
    return (*env)->NewStringUTF(env, out);
}

/* ------------------------------------------------------------------ */
/* OpenCL availability (dlopen candidates; never linked).               */
/* ------------------------------------------------------------------ */
JNIEXPORT jstring JNICALL
Java_com_findback_app_vlm_NativeProbe_nativeOpenClStatus(JNIEnv *env, jobject thiz) {
    char out[FB_BUF];
    out[0] = '\0';

    static const char *candidates[] = {
        "libOpenCL.so",
        "/system/vendor/lib64/libOpenCL.so",
        "/system/vendor/lib/libOpenCL.so",
        "libPVROCL.so",
        "libGLES_mali.so",
    };
    void *lib = NULL;
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); i++) {
        lib = dlopen(candidates[i], RTLD_NOW | RTLD_LOCAL);
        if (lib != NULL) break;
    }
    if (lib == NULL) {
        snprintf(out, sizeof(out), "unavailable");
        return (*env)->NewStringUTF(env, out);
    }
    int (*getPlatformIDs)(uint32_t, void *, uint32_t *) = dlsym(lib, "clGetPlatformIDs");
    int (*getPlatformInfo)(void *, uint32_t, size_t, void *, size_t *) =
        dlsym(lib, "clGetPlatformInfo");
    if (getPlatformIDs == NULL) {
        dlclose(lib);
        snprintf(out, sizeof(out), "unavailable");
        return (*env)->NewStringUTF(env, out);
    }
    uint32_t n = 0;
    /* num_entries=0, platforms=NULL: query count only. */
    if (getPlatformIDs(0, NULL, &n) != 0 || n == 0) {
        dlclose(lib);
        snprintf(out, sizeof(out), "unavailable");
        return (*env)->NewStringUTF(env, out);
    }
    size_t pos = 0;
    pos += (size_t)snprintf(out + pos, sizeof(out) - pos, "available:%u", n);
    if (getPlatformInfo != NULL && n <= 8) {
        /* platform ids are opaque pointers; fetch one name per platform. */
        void *ids[8];
        uint32_t got = n > 8 ? 8 : n;
        if (getPlatformIDs(got, ids, NULL) == 0) {
            for (uint32_t i = 0; i < got && pos < sizeof(out) - 8; i++) {
                char name[256];
                size_t need = 0;
                /* CL_PLATFORM_NAME = 0x0902. */
                if (getPlatformInfo(ids[i], 0x0902, sizeof(name) - 1, name, &need) == 0) {
                    name[sizeof(name) - 1] = '\0';
                    out[pos++] = ':';
                    out[pos] = '\0';
                    append_sanitised(out, sizeof(out), &pos, name);
                }
            }
        }
    }
    dlclose(lib);
    return (*env)->NewStringUTF(env, out);
}
