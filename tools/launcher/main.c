#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <ws2tcpip.h>
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

typedef struct ClientContext {
  SOCKET socket;
  char root[MAX_PATH];
  char homePage[MAX_HOME_PAGE];
} ClientContext;

static volatile LONG g_stopRequested = 0;

static void fail_and_wait(const char *message);
static int read_home_page(const char *root, char *homePage, size_t homePageSize);
static void normalize_home_page(char *value);
static int build_safe_path(const char *root, const char *relative, char *outPath, size_t outPathSize);
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
  struct sockaddr_in address;
  int addressLength = sizeof(address);
  char exePath[MAX_PATH];
  char root[MAX_PATH];
  char homePage[MAX_HOME_PAGE] = "index.html";
  char homePath[MAX_PATH];
  char url[MAX_URL];

  SetConsoleOutputCP(CP_UTF8);
  SetConsoleCP(CP_UTF8);

  if (!GetModuleFileNameA(NULL, exePath, sizeof(exePath))) {
    fail_and_wait("无法定位启动器程序。");
    return 1;
  }
  strncpy(root, exePath, sizeof(root) - 1);
  root[sizeof(root) - 1] = '\0';
  dirname_in_place(root);

  read_home_page(root, homePage, sizeof(homePage));
  if (!build_safe_path(root, homePage, homePath, sizeof(homePath))) {
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

  server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (server == INVALID_SOCKET) {
    WSACleanup();
    fail_and_wait("无法创建本地服务器。");
    return 1;
  }

  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(0);

  if (bind(server, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR ||
      listen(server, SOMAXCONN) == SOCKET_ERROR ||
      getsockname(server, (struct sockaddr *)&address, &addressLength) == SOCKET_ERROR) {
    closesocket(server);
    WSACleanup();
    fail_and_wait("无法启动本地服务器。");
    return 1;
  }

  snprintf(url, sizeof(url), "http://127.0.0.1:%u/%s", ntohs(address.sin_port), homePage);
  backslash_to_slash(url);

  printf("本地服务器已启动。\n");
  printf("游戏目录：%s\n", root);
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
    strncpy(context->root, root, sizeof(context->root) - 1);
    strncpy(context->homePage, homePage, sizeof(context->homePage) - 1);
    HANDLE thread = (HANDLE)_beginthreadex(NULL, 0, client_thread, context, 0, NULL);
    if (thread) {
      CloseHandle(thread);
    } else {
      handle_client(client, root, homePage);
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
    send_response(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found");
    closesocket(client);
    return;
  }
  if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
    char directoryIndex[MAX_HOME_PAGE];
    snprintf(directoryIndex, sizeof(directoryIndex), "%s/index.html", requestPath);
    if (!build_safe_path(root, directoryIndex, filePath, sizeof(filePath)) ||
        GetFileAttributesA(filePath) == INVALID_FILE_ATTRIBUTES) {
      send_response(client, 404, "Not Found", "text/plain; charset=utf-8", "Not found");
      closesocket(client);
      return;
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

static int read_home_page(const char *root, char *homePage, size_t homePageSize) {
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
  if (!key) {
    free(data);
    return 0;
  }
  colon = strchr(key, ':');
  quote = colon ? strchr(colon, '"') : NULL;
  end = quote ? quote + 1 : NULL;
  if (!end) {
    free(data);
    return 0;
  }
  while (*end && *end != '"') end++;
  length = (size_t)(end - quote - 1);
  if (length >= homePageSize) length = homePageSize - 1;
  memcpy(homePage, quote + 1, length);
  homePage[length] = '\0';
  normalize_home_page(homePage);
  free(data);
  return 1;
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
