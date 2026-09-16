#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winnt.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/*
 * This executable is deliberately not linked against R.dll.  It loads the
 * private R runtime copy, replaces only R.dll's two
 * GetFinalPathNameByHandle imports before R is initialized, then calls the
 * embedded-R public exports.  The hook preserves R's DOS-shaped result while
 * obtaining the canonical path through VOLUME_NAME_NT, which is available to
 * an AppContainer where VOLUME_NAME_DOS is not.
 */

typedef void *SEXP;
typedef DWORD (WINAPI *GetFinalPathNameByHandleWFn)(HANDLE, LPWSTR, DWORD, DWORD);
typedef DWORD (WINAPI *GetFinalPathNameByHandleAFn)(HANDLE, LPSTR, DWORD, DWORD);
typedef int (*InitEmbeddedRFn)(int, char **);
typedef void (*EndEmbeddedRFn)(int);
typedef SEXP (*InstallFn)(const char *);
typedef SEXP (*MkStringFn)(const char *);
typedef SEXP (*Lang2Fn)(SEXP, SEXP);
typedef SEXP (*ProtectFn)(SEXP);
typedef void (*UnprotectFn)(int);
typedef SEXP (*TryEvalFn)(SEXP, SEXP, int *);

static GetFinalPathNameByHandleWFn original_final_path_w = NULL;
static GetFinalPathNameByHandleAFn original_final_path_a = NULL;
static wchar_t expected_nt_volume[MAX_PATH];
static wchar_t trusted_dos_drive[3];
static volatile LONG hook_calls = 0;

static void fail(const char *message)
{
    fprintf(stderr, "r-appcontainer-launcher: %s\\n", message);
}

static int wide_equals_ignore_case(const wchar_t *left, const wchar_t *right)
{
    return _wcsicmp(left, right) == 0;
}

static int map_nt_path_to_dos(const wchar_t *nt_path, wchar_t *result, DWORD result_count)
{
    size_t nt_length = wcslen(expected_nt_volume);
    size_t path_length;
    size_t needed;
    if (nt_length == 0 || _wcsnicmp(nt_path, expected_nt_volume, nt_length) != 0)
        return 0;
    if (expected_nt_volume[nt_length - 1] != L'\\' || nt_path[nt_length - 1] != L'\\')
        return 0;
    path_length = wcslen(nt_path + nt_length - 1);
    needed = 4 + 2 + path_length + 1; /* \\?\\ + C: + remainder + NUL */
    if (needed > result_count) {
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return -1;
    }
    result[0] = L'\\';
    result[1] = L'\\';
    result[2] = L'?';
    result[3] = L'\\';
    result[4] = trusted_dos_drive[0];
    result[5] = L':';
    wcscpy(result + 6, nt_path + nt_length - 1);
    return (int)wcslen(result);
}

static DWORD WINAPI compatible_final_path_w(HANDLE file, LPWSTR buffer, DWORD size, DWORD flags)
{
    DWORD nt_required;
    DWORD nt_returned;
    wchar_t *nt_path;
    wchar_t *mapped;
    int mapped_length;

    if (flags != VOLUME_NAME_DOS || original_final_path_w == NULL)
        return original_final_path_w(file, buffer, size, flags);

    nt_required = original_final_path_w(file, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
    if (nt_required == 0)
        return 0;
    nt_path = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, ((SIZE_T)nt_required + 2) * sizeof(wchar_t));
    if (nt_path == NULL) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return 0;
    }
    nt_returned = original_final_path_w(file, nt_path, nt_required + 1, FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
    if (nt_returned == 0 || nt_returned > nt_required) {
        HeapFree(GetProcessHeap(), 0, nt_path);
        return 0;
    }
    if (size == 0) {
        mapped = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, ((SIZE_T)nt_returned + 4) * sizeof(wchar_t));
        if (mapped == NULL) {
            HeapFree(GetProcessHeap(), 0, nt_path);
            SetLastError(ERROR_NOT_ENOUGH_MEMORY);
            return 0;
        }
        mapped_length = map_nt_path_to_dos(nt_path, mapped, nt_returned + 4);
        HeapFree(GetProcessHeap(), 0, mapped);
        HeapFree(GetProcessHeap(), 0, nt_path);
        if (mapped_length <= 0)
            return original_final_path_w(file, buffer, size, flags);
        InterlockedIncrement(&hook_calls);
        return (DWORD)mapped_length;
    }
    mapped_length = map_nt_path_to_dos(nt_path, buffer, size);
    HeapFree(GetProcessHeap(), 0, nt_path);
    if (mapped_length < 0)
        return (DWORD)(size + 1);
    if (mapped_length == 0)
        return original_final_path_w(file, buffer, size, flags);
    InterlockedIncrement(&hook_calls);
    return (DWORD)mapped_length;
}

static DWORD WINAPI compatible_final_path_a(HANDLE file, LPSTR buffer, DWORD size, DWORD flags)
{
    DWORD required_w;
    wchar_t *wide;
    int required_a;
    int written;
    if (flags != VOLUME_NAME_DOS || original_final_path_a == NULL)
        return original_final_path_a(file, buffer, size, flags);

    required_w = compatible_final_path_w(file, NULL, 0, flags);
    if (required_w == 0)
        return 0;
    wide = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, ((SIZE_T)required_w + 2) * sizeof(wchar_t));
    if (wide == NULL) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY);
        return 0;
    }
    if (compatible_final_path_w(file, wide, required_w + 1, flags) == 0) {
        HeapFree(GetProcessHeap(), 0, wide);
        return 0;
    }
    required_a = WideCharToMultiByte(CP_ACP, 0, wide, -1, NULL, 0, NULL, NULL);
    if (required_a <= 0) {
        HeapFree(GetProcessHeap(), 0, wide);
        return 0;
    }
    if (size == 0) {
        HeapFree(GetProcessHeap(), 0, wide);
        return (DWORD)(required_a - 1);
    }
    if ((DWORD)required_a > size) {
        HeapFree(GetProcessHeap(), 0, wide);
        SetLastError(ERROR_INSUFFICIENT_BUFFER);
        return (DWORD)required_a;
    }
    written = WideCharToMultiByte(CP_ACP, 0, wide, -1, buffer, (int)size, NULL, NULL);
    HeapFree(GetProcessHeap(), 0, wide);
    return written > 0 ? (DWORD)(written - 1) : 0;
}

static int patch_r_imports(HMODULE module)
{
    uint8_t *base = (uint8_t *)module;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    IMAGE_NT_HEADERS64 *nt;
    IMAGE_IMPORT_DESCRIPTOR *descriptor;
    int patched_w = 0;
    int patched_a = 0;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE)
        return 0;
    nt = (IMAGE_NT_HEADERS64 *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
        return 0;
    descriptor = (IMAGE_IMPORT_DESCRIPTOR *)(base + nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    for (; descriptor->Name != 0; descriptor++) {
        IMAGE_THUNK_DATA64 *lookup;
        IMAGE_THUNK_DATA64 *address;
        const char *dll_name = (const char *)(base + descriptor->Name);
        if (_stricmp(dll_name, "KERNEL32.dll") != 0)
            continue;
        if (descriptor->OriginalFirstThunk == 0)
            return 0;
        lookup = (IMAGE_THUNK_DATA64 *)(base + descriptor->OriginalFirstThunk);
        address = (IMAGE_THUNK_DATA64 *)(base + descriptor->FirstThunk);
        for (; lookup->u1.AddressOfData != 0; lookup++, address++) {
            IMAGE_IMPORT_BY_NAME *name;
            DWORD old_protection;
            if (IMAGE_SNAP_BY_ORDINAL64(lookup->u1.Ordinal))
                continue;
            name = (IMAGE_IMPORT_BY_NAME *)(base + lookup->u1.AddressOfData);
            if (strcmp((const char *)name->Name, "GetFinalPathNameByHandleW") == 0) {
                if (!VirtualProtect(&address->u1.Function, sizeof(address->u1.Function), PAGE_READWRITE, &old_protection))
                    return 0;
                original_final_path_w = (GetFinalPathNameByHandleWFn)(uintptr_t)address->u1.Function;
                address->u1.Function = (ULONGLONG)(uintptr_t)compatible_final_path_w;
                VirtualProtect(&address->u1.Function, sizeof(address->u1.Function), old_protection, &old_protection);
                patched_w++;
            } else if (strcmp((const char *)name->Name, "GetFinalPathNameByHandleA") == 0) {
                if (!VirtualProtect(&address->u1.Function, sizeof(address->u1.Function), PAGE_READWRITE, &old_protection))
                    return 0;
                original_final_path_a = (GetFinalPathNameByHandleAFn)(uintptr_t)address->u1.Function;
                address->u1.Function = (ULONGLONG)(uintptr_t)compatible_final_path_a;
                VirtualProtect(&address->u1.Function, sizeof(address->u1.Function), old_protection, &old_protection);
                patched_a++;
            }
        }
    }
    FlushInstructionCache(GetCurrentProcess(), NULL, 0);
    return patched_w == 1 && patched_a == 1 && original_final_path_w != NULL && original_final_path_a != NULL;
}

static int is_sha256(const wchar_t *value)
{
    size_t index;
    if (value == NULL || wcslen(value) != 64)
        return 0;
    for (index = 0; index < 64; index++)
        if (!((value[index] >= L'0' && value[index] <= L'9') || (value[index] >= L'a' && value[index] <= L'f')))
            return 0;
    return 1;
}

static char *utf8_from_wide(const wchar_t *wide)
{
    int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1, NULL, 0, NULL, NULL);
    char *value;
    if (length <= 0)
        return NULL;
    value = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)length);
    if (value == NULL)
        return NULL;
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1, value, length, NULL, NULL) <= 0) {
        HeapFree(GetProcessHeap(), 0, value);
        return NULL;
    }
    return value;
}

static void write_attestation(const wchar_t *path, const wchar_t *adapter_hash, const wchar_t *r_dll_hash, int initialized, int evaluated, int evaluation_error)
{
    HANDLE file;
    char payload[2048];
    DWORD written;
    if (!is_sha256(adapter_hash) || !is_sha256(r_dll_hash))
        return;
    _snprintf(payload, sizeof(payload), "{\"mode\":\"r-4.5.1-appcontainer-nt-volume-iat\",\"adapterSha256\":\"%ls\",\"rDllSha256\":\"%ls\",\"iatPatched\":true,\"hookCalls\":%ld,\"initialized\":%s,\"evaluated\":%s,\"evaluationError\":%s}\n", adapter_hash, r_dll_hash, (long)hook_calls, initialized ? "true" : "false", evaluated ? "true" : "false", evaluation_error ? "true" : "false");
    file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        WriteFile(file, payload, (DWORD)strlen(payload), &written, NULL);
        CloseHandle(file);
    }
}

static const wchar_t *read_argument(int argc, wchar_t **argv, const wchar_t *name)
{
    int index;
    for (index = 1; index + 1 < argc; index++)
        if (wide_equals_ignore_case(argv[index], name))
            return argv[index + 1];
    return NULL;
}

int wmain(int argc, wchar_t **argv)
{
    const wchar_t *r_dll = read_argument(argc, argv, L"--r-dll");
    const wchar_t *script = read_argument(argc, argv, L"--script");
    const wchar_t *nt_volume = read_argument(argc, argv, L"--nt-volume");
    const wchar_t *dos_drive = read_argument(argc, argv, L"--dos-drive");
    const wchar_t *attestation = read_argument(argc, argv, L"--attestation");
    const wchar_t *adapter_hash = read_argument(argc, argv, L"--adapter-sha256");
    const wchar_t *r_dll_hash = read_argument(argc, argv, L"--r-dll-sha256");
    HMODULE r_module;
    wchar_t r_dll_directory[MAX_PATH];
    wchar_t *last_separator;
    InitEmbeddedRFn init_embedded_r;
    EndEmbeddedRFn end_embedded_r;
    InstallFn install;
    MkStringFn mk_string;
    Lang2Fn lang2;
    ProtectFn protect;
    UnprotectFn unprotect;
    TryEvalFn try_eval;
    SEXP *global_environment;
    SEXP expression;
    char *script_utf8;
    char *r_argv[] = { "R", "--silent", "--no-restore", "--no-save", "--no-environ" };
    int initialized = 0;
    int evaluated = 0;
    int evaluation_error = 1;
    int exit_code = 1;

    if (r_dll == NULL || script == NULL || nt_volume == NULL || dos_drive == NULL || attestation == NULL || !is_sha256(adapter_hash) || !is_sha256(r_dll_hash) || wcslen(dos_drive) != 2 || dos_drive[1] != L':') {
        fail("required compatibility arguments are missing");
        return 64;
    }
    if (wcslen(nt_volume) == 0 || wcslen(nt_volume) >= MAX_PATH) {
        fail("trusted NT volume mapping is invalid");
        return 64;
    }
    wcscpy(expected_nt_volume, nt_volume);
    trusted_dos_drive[0] = dos_drive[0];
    trusted_dos_drive[1] = L':';
    trusted_dos_drive[2] = L'\0';
    if (wcslen(r_dll) >= MAX_PATH) {
        fail("private R.dll path exceeds the adapter limit");
        return 64;
    }
    wcscpy(r_dll_directory, r_dll);
    last_separator = wcsrchr(r_dll_directory, L'\\');
    if (last_separator == NULL) {
        fail("private R.dll path has no directory");
        return 64;
    }
    *last_separator = L'\0';
    if (!SetDllDirectoryW(r_dll_directory)) {
        fail("private R.dll directory could not be selected");
        return 64;
    }
    r_module = LoadLibraryW(r_dll);
    if (r_module == NULL) {
        fail("private R.dll could not be loaded");
        return 65;
    }
    if (!patch_r_imports(r_module)) {
        fail("R.dll import layout did not match the audited compatibility adapter");
        FreeLibrary(r_module);
        return 66;
    }
    init_embedded_r = (InitEmbeddedRFn)(uintptr_t)GetProcAddress(r_module, "Rf_initEmbeddedR");
    end_embedded_r = (EndEmbeddedRFn)(uintptr_t)GetProcAddress(r_module, "Rf_endEmbeddedR");
    install = (InstallFn)(uintptr_t)GetProcAddress(r_module, "Rf_install");
    mk_string = (MkStringFn)(uintptr_t)GetProcAddress(r_module, "Rf_mkString");
    lang2 = (Lang2Fn)(uintptr_t)GetProcAddress(r_module, "Rf_lang2");
    protect = (ProtectFn)(uintptr_t)GetProcAddress(r_module, "Rf_protect");
    unprotect = (UnprotectFn)(uintptr_t)GetProcAddress(r_module, "Rf_unprotect");
    try_eval = (TryEvalFn)(uintptr_t)GetProcAddress(r_module, "R_tryEval");
    global_environment = (SEXP *)GetProcAddress(r_module, "R_GlobalEnv");
    if (init_embedded_r == NULL || end_embedded_r == NULL || install == NULL || mk_string == NULL || lang2 == NULL || protect == NULL || unprotect == NULL || try_eval == NULL || global_environment == NULL) {
        fail("R.dll required embedded API exports are unavailable");
        FreeLibrary(r_module);
        return 67;
    }
    if (init_embedded_r((int)(sizeof(r_argv) / sizeof(r_argv[0])), r_argv) < 0) {
        fail("Rf_initEmbeddedR failed");
        write_attestation(attestation, adapter_hash, r_dll_hash, initialized, evaluated, evaluation_error);
        FreeLibrary(r_module);
        return 68;
    }
    initialized = 1;
    script_utf8 = utf8_from_wide(script);
    if (script_utf8 == NULL) {
        fail("script path is not valid UTF-8");
        goto cleanup;
    }
    expression = protect(lang2(install("source"), mk_string(script_utf8)));
    try_eval(expression, *global_environment, &evaluation_error);
    unprotect(1);
    HeapFree(GetProcessHeap(), 0, script_utf8);
    evaluated = 1;
    if (evaluation_error) {
        fail("R script evaluation failed");
        goto cleanup;
    }
    exit_code = 0;

cleanup:
    write_attestation(attestation, adapter_hash, r_dll_hash, initialized, evaluated, evaluation_error);
    if (initialized)
        end_embedded_r(exit_code == 0 ? 0 : 1);
    FreeLibrary(r_module);
    return exit_code;
}
