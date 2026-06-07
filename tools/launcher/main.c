#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <windows.h>
#include <shellapi.h>

#include <ctype.h>
#include <process.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BUFFER_SIZE 8192
#define MAX_HOME_PAGE 512
#define MAX_URL 1024
#define MIN_USER_PORT 1
#define MIN_RANDOM_PREVIEW_PORT 10001
#define MAX_PREVIEW_PORT 65535

typedef struct LauncherConfig {
  char homePage[MAX_HOME_PAGE];
  char rootDirectory[MAX_HOME_PAGE];
  unsigned short port;
  int hasPort;
} LauncherConfig;

typedef struct ClientContext {
  SOCKET socket;
  char root[MAX_PATH];
  char homePage[MAX_HOME_PAGE];
} ClientContext;

static volatile LONG g_stopRequested = 0;

static void fail_and_wait(const char *message);
static int read_launcher_config(const char *root, LauncherConfig *config);
static int write_launcher_config(const char *root, const LauncherConfig *config);
static void normalize_home_page(char *value);
static void normalize_root_directory(char *value);
static SOCKET create_listening_server(unsigned short configuredPort, int hasConfiguredPort, unsigned short *actualPort, char *errorMessage, size_t errorMessageSize);
static int bind_and_listen(SOCKET server, unsigned short port, unsigned short *actualPort);
static unsigned short random_preview_port(void);
static void describe_port_owner(unsigned short port, char *out, size_t outSize);
static int build_safe_path(const char *root, const char *relative, char *outPath, size_t outPathSize);
static int try_html_fallback_path(const char *root, const char *requestPath, char *outPath, size_t outPathSize);
static int request_path_has_extension(const char *path);
static unsigned __stdcall input_thread(void *arg);
static unsigned __stdcall client_thread(void *arg);
static void handle_client(SOCKET client, const char *root, const char *homePage);
static int parse_request_path(const char *request, char *path, size_t pathSize);
static void url_decode(char *value);
static void send_response(SOCKET client, int status, const char *statusText, const char *contentType, const char *body);
static void serve_file(SOCKET client, const char *path, int headOnly);
static const char *content_type_for(const char *path);
static void open_browser(const char *url);
static void dirname_in_place(char *path);
static void slash_to_backslash(char *value);
static void backslash_to_slash(char *value);
static int starts_with_path_case_insensitive(const char *child, const char *parent);
static void wait_for_enter(void);

int main(void) {
  WSADATA wsa;
  SOCKET server;
  char exePath[MAX_PATH];
  char launcherRoot[MAX_PATH];
  char contentRoot[MAX_PATH];
  char homePath[MAX_PATH];
  char url[MAX_URL];
  char bindError[1024];
  unsigned short actualPort = 0;
  LauncherConfig config;

  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);

  if (!GetModuleFileNameA(NULL, exePath, sizeof(exePath))) {
    fail_and_wait("无法定位启动器程序。");
    return 1;
  }
  strncpy(launcherRoot, exePath, sizeof(launcherRoot) - 1);
  launcherRoot[sizeof(launcherRoot) - 1] = '\0';
  dirname_in_place(launcherRoot);

  read_launcher_config(launcherRoot, &config);
  if (!build_safe_path(launcherRoot, config.rootDirectory, contentRoot, sizeof(contentRoot))) {
    fail_and_wait("根目录不能指向启动器目录外。");
    return 1;
  }
  DWORD contentAttributes = GetFileAttributesA(contentRoot);
  if (contentAttributes == INVALID_FILE_ATTRIBUTES || !(contentAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
    fail_and_wait("没有找到配置的根目录。");
    return 1;
  }
  if (!build_safe_path(contentRoot, config.homePage, homePath, sizeof(homePath))) {
    fail_and_wait("首页路径不能指向游戏目录外。");
    return 1;
  }
  if (GetFileAttributesA(homePath) == INVALID_FILE_ATTRIBUTES) {
    fail_and_wait("没有找到配置的首页文件。");
    return 1;
  }

  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    fail_and_wait("无法初始化本地网络服务。");
    return 1;
  }

  srand((unsigned int)(GetTickCount() ^ GetCurrentProcessId()));
  server = create_listening_server(config.port, config.hasPort, &actualPort, bindError, sizeof(bindError));
  if (server == INVALID_SOCKET) {
    WSACleanup();
    fail_and_wait(bindError[0] ? bindError : "无法创建本地服务器。");
    return 1;
  }

  if (!config.hasPort) {
    config.port = actualPort;
    config.hasPort = 1;
    if (!write_launcher_config(launcherRoot, &config)) {
      printf("警告：无法写入 BGT-Launcher.json，端口下次可能重新分配。\n");
    }
  }

  snprintf(url, sizeof(url), "http://127.0.0.1:%u/%s", actualPort, config.homePage);
  backslash_to_slash(url);

  printf("本地服务器已启动。\n");
  printf("启动器目录：%s\n", launcherRoot);
  printf("游戏目录：%s\n", contentRoot);
  printf("正在打开：%s\n", url);
  open_browser(url);
  printf("游玩时保持此窗口开启。按 Enter 停止网页服务。\n");

  HANDLE inputThread = (HANDLE)_beginthreadex(NULL, 0, input_thread, NULL, 0, NULL);
  if (inputThread) CloseHandle(inputThread);

  while (InterlockedCompareExchange(&g_stopRequested, 0, 0) == 0) {
    fd_set readSet;
    struct timeval timeout;
    SOCKET client;

    FD_ZERO(&readSet);
    FD_SET(server, &readSet);
    timeout.tv_sec = 0;
    timeout.tv_usec = 250000;

    if (select(0, &readSet, NULL, NULL, &timeout) <= 0) continue;
    client = accept(server, NULL, NULL);
    if (client == INVALID_SOCKET) continue;

    ClientContext *context = (ClientContext *)calloc(1, sizeof(ClientContext));
    if (!context) {
      closesocket(client);
      continue;
    }
    context->socket = client;
    strncpy(context->root, contentRoot, sizeof(context->root) - 1);
    strncpy(context->homePage, config.homePage, sizeof(context->homePage) - 1);
    HANDLE thread = (HANDLE)_beginthreadex(NULL, 0, client_thread, context, 0, NULL);
    if (thread) {
      CloseHandle(thread);
    } else {
      handle_client(client, contentRoot, config.homePage);
      free(context);
    }
  }

  closesocket(server);
  WSACleanup();
  return 0;
}

static unsigned __stdcall input_thread(void *arg) {
  (void)arg;
  wait_for_enter();
  InterlockedExchange(&g_stopRequested, 1);
  return 0;
}

static unsigned __stdcall client_thread(void *arg) {
  ClientContext *context = (ClientContext *)arg;
  handle_client(context->socket, context->root, context->homePage);
  free(context);
  return 0;
}

static void handle_client(SOCKET client, const char *root, const char *homePage) {
  char buffer[BUFFER_SIZE + 1];
  char requestPath[MAX_HOME_PAGE];
  char filePath[MAX_PATH];
  int received;
  int headOnly = 0;

  received = recv(client, buffer, BUFFER_SIZE, 0);
  if (received <= 0) {
    closesocket(client);
    return;
  }
  buffer[received] = '\0';
  headOnly = strncmp(buffer, "HEAD ", 5) == 0;

  if (strncmp(buffer, "GET ", 4) != 0 && !headOnly) {
    send_response(client, 405, "Method Not Allowed", "text/plain; charset=utf-8", "Method not allowed");
    closesocket(client);
    return;
  }

  if (!parse_request_path(buffer, requestPath, sizeof(requestPath))) {
    send_response(client, 400, "Bad Request", "text/plain; charset=utf-8", "Bad request");
    closesocket(client);
    return;
  }
  if (requestPath[0] == '\0') {
    strncpy(requestPath, homePage, sizeof(requestPath) - 1);
    requestPath[sizeof(requestPath) - 1] = '\0';
  }

  if (!build_safe_path(root, requestPath, filePath, sizeof(filePath))) {
    send_response(client, 403, "Forbidden", "text/plain; charset=utf-8", "Forbidden");
    closesocket(client);
    return;
  }

  DWORD attributes = GetFileAttributesA(filePath);
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    if (!try_html_fallback_path(root, requestPath, filePath, sizeof(filePath))) {
      send_response(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found");
      closesocket(client);
      return;
    }
    attributes = GetFileAttributesA(filePath);
  }
  if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
    char directoryIndex[MAX_HOME_PAGE];
    snprintf(directoryIndex, sizeof(directoryIndex), "%s/index.html", requestPath);
    if (!build_safe_path(root, directoryIndex, filePath, sizeof(filePath)) ||
        GetFileAttributesA(filePath) == INVALID_FILE_ATTRIBUTES) {
      if (!try_html_fallback_path(root, requestPath, filePath, sizeof(filePath))) {
        send_response(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found");
        closesocket(client);
        return;
      }
    }
  }

  serve_file(client, filePath, headOnly);
  closesocket(client);
}

static int parse_request_path(const char *request, char *path, size_t pathSize) {
  const char *firstSpace = strchr(request, ' ');
  const char *secondSpace;
  size_t length;
  if (!firstSpace) return 0;
  secondSpace = strchr(firstSpace + 1, ' ');
  if (!secondSpace) return 0;
  length = (size_t)(secondSpace - firstSpace - 1);
  if (length >= pathSize) length = pathSize - 1;
  memcpy(path, firstSpace + 1, length);
  path[length] = '\0';
  char *query = strchr(path, '?');
  if (query) *query = '\0';
  while (path[0] == '/') memmove(path, path + 1, strlen(path));
  url_decode(path);
  normalize_home_page(path);
  return 1;
}

static void serve_file(SOCKET client, const char *path, int headOnly) {
  HANDLE file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  LARGE_INTEGER size;
  char header[512];
  DWORD readBytes;
  char buffer[BUFFER_SIZE];

  if (file == INVALID_HANDLE_VALUE) {
    send_response(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found");
    return;
  }
  if (!GetFileSizeEx(file, &size)) {
    CloseHandle(file);
    send_response(client, 500, "Internal Server Error", "text/plain; charset=utf-8", "Cannot read file");
    return;
  }

  snprintf(
    header,
    sizeof(header),
    "HTTP/1.1 200 OK\r\nContent-Length: %lld\r\nContent-Type: %s\r\nConnection: close\r\n\r\n",
    (long long)size.QuadPart,
    content_type_for(path)
  );
  send(client, header, (int)strlen(header), 0);

  if (!headOnly) {
    while (ReadFile(file, buffer, sizeof(buffer), &readBytes, NULL) && readBytes > 0) {
      send(client, buffer, (int)readBytes, 0);
    }
  }
  CloseHandle(file);
}

static void send_response(SOCKET client, int status, const char *statusText, const char *contentType, const char *body) {
  char header[512];
  int bodyLength = body ? (int)strlen(body) : 0;
  snprintf(
    header,
    sizeof(header),
    "HTTP/1.1 %d %s\r\nContent-Length: %d\r\nContent-Type: %s\r\nConnection: close\r\n\r\n",
    status,
    statusText,
    bodyLength,
    contentType
  );
  send(client, header, (int)strlen(header), 0);
  if (bodyLength > 0) send(client, body, bodyLength, 0);
}

static int read_launcher_config(const char *root, LauncherConfig *config) {
  char configPath[MAX_PATH];
  HANDLE file;
  DWORD size;
  DWORD readBytes;
  char *data;
  char *key;
  char *colon;
  char *quote;
  char *end;
  size_t length;
  char *rootKey;
  char *rootColon;
  char *rootQuote;
  char *rootEnd;
  char *portKey;
  char *portColon;
  char *portStart;
  unsigned long parsedPort;

  memset(config, 0, sizeof(*config));
  strcpy(config->homePage, "index.html");
  strcpy(config->rootDirectory, "www");

  snprintf(configPath, sizeof(configPath), "%s\\BGT-Launcher.json", root);
  file = CreateFileA(configPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 0;
  size = GetFileSize(file, NULL);
  if (size == INVALID_FILE_SIZE || size > 65536) {
    CloseHandle(file);
    return 0;
  }
  data = (char *)calloc(size + 1, 1);
  if (!data) {
    CloseHandle(file);
    return 0;
  }
  ReadFile(file, data, size, &readBytes, NULL);
  CloseHandle(file);

  key = strstr(data, "\"homePage\"");
  if (key) {
    colon = strchr(key, ':');
    quote = colon ? strchr(colon, '"') : NULL;
    end = quote ? quote + 1 : NULL;
    if (end) {
      while (*end && *end != '"') end++;
      length = (size_t)(end - quote - 1);
      if (length >= sizeof(config->homePage)) length = sizeof(config->homePage) - 1;
      memcpy(config->homePage, quote + 1, length);
      config->homePage[length] = '\0';
      normalize_home_page(config->homePage);
    }
  }

  rootKey = strstr(data, "\"rootDirectory\"");
  if (rootKey) {
    rootColon = strchr(rootKey, ':');
    rootQuote = rootColon ? strchr(rootColon, '"') : NULL;
    rootEnd = rootQuote ? rootQuote + 1 : NULL;
    if (rootEnd) {
      while (*rootEnd && *rootEnd != '"') rootEnd++;
      length = (size_t)(rootEnd - rootQuote - 1);
      if (length >= sizeof(config->rootDirectory)) length = sizeof(config->rootDirectory) - 1;
      memcpy(config->rootDirectory, rootQuote + 1, length);
      config->rootDirectory[length] = '\0';
      normalize_root_directory(config->rootDirectory);
    }
  }

  portKey = strstr(data, "\"port\"");
  portColon = portKey ? strchr(portKey, ':') : NULL;
  portStart = portColon ? portColon + 1 : NULL;
  if (portStart) {
    while (isspace((unsigned char)*portStart)) portStart++;
    parsedPort = strtoul(portStart, NULL, 10);
    if (parsedPort >= MIN_USER_PORT && parsedPort <= MAX_PREVIEW_PORT) {
      config->port = (unsigned short)parsedPort;
      config->hasPort = 1;
    }
  }

  free(data);
  return 1;
}

static int write_launcher_config(const char *root, const LauncherConfig *config) {
  char configPath[MAX_PATH];
  char homePage[MAX_HOME_PAGE];
  char rootDirectory[MAX_HOME_PAGE];
  char data[1024];
  HANDLE file;
  DWORD written;

  strncpy(homePage, config->homePage, sizeof(homePage) - 1);
  homePage[sizeof(homePage) - 1] = '\0';
  backslash_to_slash(homePage);
  strncpy(rootDirectory, config->rootDirectory, sizeof(rootDirectory) - 1);
  rootDirectory[sizeof(rootDirectory) - 1] = '\0';
  backslash_to_slash(rootDirectory);
  snprintf(configPath, sizeof(configPath), "%s\\BGT-Launcher.json", root);
  snprintf(data, sizeof(data), "{\r\n  \"rootDirectory\": \"%s\",\r\n  \"homePage\": \"%s\",\r\n  \"port\": %u\r\n}\r\n", rootDirectory, homePage, config->port);

  file = CreateFileA(configPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 0;
  if (!WriteFile(file, data, (DWORD)strlen(data), &written, NULL)) {
    CloseHandle(file);
    return 0;
  }
  CloseHandle(file);
  return written == strlen(data);
}

static void normalize_home_page(char *value) {
  char *start = value;
  char *end;
  while (isspace((unsigned char)*start)) start++;
  if (start != value) memmove(value, start, strlen(start) + 1);
  slash_to_backslash(value);
  while (value[0] == '\\' || value[0] == '/') memmove(value, value + 1, strlen(value));
  end = value + strlen(value);
  while (end > value && isspace((unsigned char)end[-1])) {
    end[-1] = '\0';
    end--;
  }
  if (value[0] == '\0') strcpy(value, "index.html");
}

static void normalize_root_directory(char *value) {
  char *start = value;
  char *end;
  while (isspace((unsigned char)*start)) start++;
  if (start != value) memmove(value, start, strlen(start) + 1);
  slash_to_backslash(value);
  while (value[0] == '\\' || value[0] == '/') memmove(value, value + 1, strlen(value));
  end = value + strlen(value);
  while (end > value && isspace((unsigned char)end[-1])) {
    end[-1] = '\0';
    end--;
  }
  while (end > value && (end[-1] == '\\' || end[-1] == '/')) {
    end[-1] = '\0';
    end--;
  }
  if (value[0] == '\0') strcpy(value, "www");
}

static SOCKET create_listening_server(unsigned short configuredPort, int hasConfiguredPort, unsigned short *actualPort, char *errorMessage, size_t errorMessageSize) {
  SOCKET server;
  int attempt;

  if (errorMessageSize > 0) errorMessage[0] = '\0';

  if (hasConfiguredPort) {
    server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) {
      snprintf(errorMessage, errorMessageSize, "无法创建本地服务器。");
      return INVALID_SOCKET;
    }
    if (bind_and_listen(server, configuredPort, actualPort)) return server;
    if (WSAGetLastError() == WSAEADDRINUSE) {
      char owner[512];
      describe_port_owner(configuredPort, owner, sizeof(owner));
      snprintf(
        errorMessage,
        errorMessageSize,
        "配置的端口 %u 已被占用。\n占用程序：%s\n请关闭该程序后重试，或修改 BGT-Launcher.json 中的 port。修改端口可能导致浏览器无法读取原端口下的网页游戏存档。",
        configuredPort,
        owner
      );
    } else {
      snprintf(errorMessage, errorMessageSize, "无法启动本地服务器，端口：%u。", configuredPort);
    }
    closesocket(server);
    return INVALID_SOCKET;
  }

  for (attempt = 0; attempt < 160; attempt++) {
    unsigned short port = random_preview_port();
    server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) {
      snprintf(errorMessage, errorMessageSize, "无法创建本地服务器。");
      return INVALID_SOCKET;
    }
    if (bind_and_listen(server, port, actualPort)) return server;
    closesocket(server);
  }

  snprintf(errorMessage, errorMessageSize, "自动分配本地服务端口失败。启动器已尝试 10001-65535 范围内的随机端口，请检查安全软件、防火墙或在 BGT-Launcher.json 中手动指定 port。");
  return INVALID_SOCKET;
}

static int bind_and_listen(SOCKET server, unsigned short port, unsigned short *actualPort) {
  struct sockaddr_in address;
  int addressLength = sizeof(address);

  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(port);

  if (bind(server, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR ||
      listen(server, SOMAXCONN) == SOCKET_ERROR ||
      getsockname(server, (struct sockaddr *)&address, &addressLength) == SOCKET_ERROR) {
    return 0;
  }
  *actualPort = ntohs(address.sin_port);
  return 1;
}

static unsigned short random_preview_port(void) {
  return (unsigned short)(MIN_RANDOM_PREVIEW_PORT + (rand() % (MAX_PREVIEW_PORT - MIN_RANDOM_PREVIEW_PORT + 1)));
}

static void describe_port_owner(unsigned short port, char *out, size_t outSize) {
  DWORD size = 0;
  PMIB_TCPTABLE_OWNER_PID table = NULL;
  DWORD result;
  DWORD index;

  snprintf(out, outSize, "未知程序");
  result = GetExtendedTcpTable(NULL, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (result != ERROR_INSUFFICIENT_BUFFER || size == 0) return;
  table = (PMIB_TCPTABLE_OWNER_PID)malloc(size);
  if (!table) return;
  result = GetExtendedTcpTable(table, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (result != NO_ERROR) {
    free(table);
    return;
  }

  for (index = 0; index < table->dwNumEntries; index++) {
    MIB_TCPROW_OWNER_PID row = table->table[index];
    if (ntohs((u_short)row.dwLocalPort) == port) {
      DWORD pid = row.dwOwningPid;
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (process) {
        char processPath[MAX_PATH];
        DWORD processPathSize = sizeof(processPath);
        if (QueryFullProcessImageNameA(process, 0, processPath, &processPathSize)) {
          char *name = strrchr(processPath, '\\');
          snprintf(out, outSize, "%s (PID %lu)", name ? name + 1 : processPath, (unsigned long)pid);
        } else {
          snprintf(out, outSize, "PID %lu", (unsigned long)pid);
        }
        CloseHandle(process);
      } else {
        snprintf(out, outSize, "PID %lu", (unsigned long)pid);
      }
      free(table);
      return;
    }
  }

  free(table);
}

static int build_safe_path(const char *root, const char *relative, char *outPath, size_t outPathSize) {
  char rootFull[MAX_PATH];
  char rootWithSlash[MAX_PATH];
  char combined[MAX_PATH * 2];
  char relativeCopy[MAX_HOME_PAGE];
  DWORD rootLength;
  DWORD pathLength;

  strncpy(relativeCopy, relative, sizeof(relativeCopy) - 1);
  relativeCopy[sizeof(relativeCopy) - 1] = '\0';
  slash_to_backslash(relativeCopy);
  if (strstr(relativeCopy, ":")) return 0;

  rootLength = GetFullPathNameA(root, sizeof(rootFull), rootFull, NULL);
  if (rootLength == 0 || rootLength >= sizeof(rootFull)) return 0;
  snprintf(rootWithSlash, sizeof(rootWithSlash), "%s%s", rootFull, rootFull[strlen(rootFull) - 1] == '\\' ? "" : "\\");
  snprintf(combined, sizeof(combined), "%s\\%s", rootFull, relativeCopy);
  pathLength = GetFullPathNameA(combined, (DWORD)outPathSize, outPath, NULL);
  if (pathLength == 0 || pathLength >= outPathSize) return 0;
  return starts_with_path_case_insensitive(outPath, rootWithSlash) || _stricmp(outPath, rootFull) == 0;
}

static int try_html_fallback_path(const char *root, const char *requestPath, char *outPath, size_t outPathSize) {
  char fallback[MAX_HOME_PAGE];
  DWORD attributes;
  size_t length = strlen(requestPath);

  if (length == 0 || requestPath[length - 1] == '\\' || requestPath[length - 1] == '/' || request_path_has_extension(requestPath)) return 0;
  if (length + 5 >= sizeof(fallback)) return 0;
  snprintf(fallback, sizeof(fallback), "%s.html", requestPath);
  if (!build_safe_path(root, fallback, outPath, outPathSize)) return 0;
  attributes = GetFileAttributesA(outPath);
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static int request_path_has_extension(const char *path) {
  const char *slash = strrchr(path, '\\');
  const char *forwardSlash = strrchr(path, '/');
  const char *base;
  if (!slash || (forwardSlash && forwardSlash > slash)) slash = forwardSlash;
  base = slash ? slash + 1 : path;
  return strchr(base, '.') != NULL;
}

static int starts_with_path_case_insensitive(const char *child, const char *parent) {
  size_t parentLength = strlen(parent);
  return _strnicmp(child, parent, parentLength) == 0;
}

static void url_decode(char *value) {
  char *source = value;
  char *dest = value;
  while (*source) {
    if (source[0] == '%' && isxdigit((unsigned char)source[1]) && isxdigit((unsigned char)source[2])) {
      char hex[3] = { source[1], source[2], '\0' };
      *dest++ = (char)strtol(hex, NULL, 16);
      source += 3;
    } else {
      *dest++ = *source++;
    }
  }
  *dest = '\0';
}

static const char *content_type_for(const char *path) {
  const char *extension = strrchr(path, '.');
  if (!extension) return "application/octet-stream";
  if (_stricmp(extension, ".html") == 0 || _stricmp(extension, ".htm") == 0) return "text/html; charset=utf-8";
  if (_stricmp(extension, ".js") == 0 || _stricmp(extension, ".mjs") == 0) return "text/javascript; charset=utf-8";
  if (_stricmp(extension, ".css") == 0) return "text/css; charset=utf-8";
  if (_stricmp(extension, ".json") == 0) return "application/json; charset=utf-8";
  if (_stricmp(extension, ".wasm") == 0) return "application/wasm";
  if (_stricmp(extension, ".png") == 0) return "image/png";
  if (_stricmp(extension, ".jpg") == 0 || _stricmp(extension, ".jpeg") == 0) return "image/jpeg";
  if (_stricmp(extension, ".gif") == 0) return "image/gif";
  if (_stricmp(extension, ".webp") == 0) return "image/webp";
  if (_stricmp(extension, ".svg") == 0) return "image/svg+xml";
  if (_stricmp(extension, ".ico") == 0) return "image/x-icon";
  if (_stricmp(extension, ".mp3") == 0) return "audio/mpeg";
  if (_stricmp(extension, ".ogg") == 0) return "audio/ogg";
  if (_stricmp(extension, ".wav") == 0) return "audio/wav";
  if (_stricmp(extension, ".mp4") == 0) return "video/mp4";
  if (_stricmp(extension, ".webm") == 0) return "video/webm";
  if (_stricmp(extension, ".ttf") == 0) return "font/ttf";
  if (_stricmp(extension, ".otf") == 0) return "font/otf";
  if (_stricmp(extension, ".woff") == 0) return "font/woff";
  if (_stricmp(extension, ".woff2") == 0) return "font/woff2";
  return "application/octet-stream";
}

static void open_browser(const char *url) {
  ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
}

static void dirname_in_place(char *path) {
  char *slash = strrchr(path, '\\');
  if (slash) *slash = '\0';
}

static void slash_to_backslash(char *value) {
  for (; *value; value++) {
    if (*value == '/') *value = '\\';
  }
}

static void backslash_to_slash(char *value) {
  for (; *value; value++) {
    if (*value == '\\') *value = '/';
  }
}

static void fail_and_wait(const char *message) {
  fprintf(stderr, "%s\n", message);
  printf("按 Enter 退出。\n");
  wait_for_enter();
}

static void wait_for_enter(void) {
  int ch;
  do {
    ch = getchar();
  } while (ch != '\n' && ch != EOF);
}
