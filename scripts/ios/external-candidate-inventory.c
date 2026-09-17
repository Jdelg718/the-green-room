#define _DARWIN_C_SOURCE
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#ifdef GREENROOM_NODE_ADDON
#include <node_api.h>
#endif

#define MAX_ENTRIES 20000ULL
#define MAX_FILE_BYTES (256ULL * 1024ULL * 1024ULL)
#define MAX_TOTAL_BYTES (2ULL * 1024ULL * 1024ULL * 1024ULL)
#define DEADLINE_SECONDS 120

static const char *inject_action;
static const char *inject_path;
static const char *inject_target;
static const char *cleanup_inject_action;
static const char *cleanup_inject_path;
static uint64_t inventory_entries;
static uint64_t inventory_total_bytes;
static struct timespec inventory_started;
static uint64_t quarantine_sequence;

static void die(const char *message) {
  fprintf(stderr, "external inventory helper: %s\n", message);
  exit(1);
}

static void enforce_deadline(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec - inventory_started.tv_sec > DEADLINE_SECONDS) die("RESOURCE_DEADLINE_EXCEEDED");
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int same_version(const struct stat *left, const struct stat *right) {
  return same_identity(left, right) && left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid && left->st_rdev == right->st_rdev &&
         left->st_size == right->st_size && left->st_blocks == right->st_blocks && left->st_blksize == right->st_blksize &&
         left->st_flags == right->st_flags && left->st_gen == right->st_gen &&
         left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec && left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
         left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec && left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec &&
         left->st_birthtimespec.tv_sec == right->st_birthtimespec.tv_sec && left->st_birthtimespec.tv_nsec == right->st_birthtimespec.tv_nsec;
}

static int compare_names(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}

static void print_hex(const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  while (*cursor != '\0') printf("%02x", *cursor++);
}

static char *child_path(const char *prefix, const char *name) {
  size_t prefix_length = strlen(prefix);
  size_t length = prefix_length + (prefix_length == 0 ? 0 : 1) + strlen(name) + 1;
  char *result = malloc(length);
  if (result == NULL) die("allocation failed");
  snprintf(result, length, prefix_length == 0 ? "%s" : "%s/%s", prefix_length == 0 ? name : prefix, name);
  return result;
}

static void inject_if_requested(int directory_fd, const char *name, const char *relative_path, mode_t mode) {
  if (inject_action == NULL || strcmp(relative_path, inject_path) != 0) return;
  if (strcmp(inject_action, "file-symlink") == 0) {
    if (!S_ISREG(mode) || unlinkat(directory_fd, name, 0) != 0 || symlinkat(inject_target, directory_fd, name) != 0) die("file symlink injection failed");
  } else if (strcmp(inject_action, "file-replacement") == 0) {
    if (!S_ISREG(mode) || unlinkat(directory_fd, name, 0) != 0) die("file replacement injection failed");
    int replacement = openat(directory_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (replacement < 0 || write(replacement, "replacement", 11) != 11 || close(replacement) != 0) die("file replacement injection failed");
  } else if (strcmp(inject_action, "file-inplace") == 0) {
    if (!S_ISREG(mode)) die("file in-place injection target is not a regular file");
    int replacement = openat(directory_fd, name, O_WRONLY | O_NOFOLLOW);
    if (replacement < 0 || pwrite(replacement, "X", 1, 0) != 1 || fsync(replacement) != 0 || close(replacement) != 0) die("file in-place injection failed");
  } else if (strcmp(inject_action, "directory-symlink") == 0) {
    if (!S_ISDIR(mode)) die("directory symlink injection target is not a directory");
    char replacement[512];
    if (snprintf(replacement, sizeof(replacement), ".inventory-replaced-%ld", (long)getpid()) >= (int)sizeof(replacement)) die("injection path is too long");
    if (renameat(directory_fd, name, directory_fd, replacement) != 0 || symlinkat(inject_target, directory_fd, name) != 0) die("directory symlink injection failed");
  } else {
    die("unknown injection action");
  }
}

static void read_file_at(int parent, const char *name, int inject_inplace) {
  struct stat before;
  if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1) die("READ_TARGET_INVALID");
  if ((uint64_t)before.st_size > MAX_FILE_BYTES) die("RESOURCE_FILE_LIMIT");
  int source = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (source < 0) die("read target openat failed");
  struct stat opened;
  if (fstat(source, &opened) != 0 || !S_ISREG(opened.st_mode) || !same_version(&before, &opened)) die("read target changed before openat");
  if (inject_inplace) {
    int writer = openat(parent, name, O_WRONLY | O_NOFOLLOW);
    if (writer < 0 || pwrite(writer, "X", 1, 0) != 1 || fsync(writer) != 0 || close(writer) != 0) die("read in-place injection failed");
  }
  unsigned char buffer[65536];
  uint64_t total = 0;
  for (;;) {
    enforce_deadline();
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0) die("read target read failed");
    if (count == 0) break;
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(STDOUT_FILENO, buffer + offset, (size_t)(count - offset));
      if (written <= 0) die("read target output failed");
      offset += written;
    }
    total += (uint64_t)count;
  }
  struct stat final_descriptor;
  struct stat final_entry;
  if (fstat(source, &final_descriptor) != 0 || fstatat(parent, name, &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_version(&opened, &final_descriptor) || !same_version(&opened, &final_entry) || !S_ISREG(final_entry.st_mode) ||
      (uint64_t)final_descriptor.st_size != total) die("read target changed or was replaced while reading");
  fprintf(stderr, "MODE=%o\n", opened.st_mode & 0777);
  if (close(source) != 0) die("read target close failed");
}

static void quarantine_name(char *buffer, size_t size) {
  quarantine_sequence++;
  if (snprintf(buffer, size, ".greenroom-cleanup-%ld-%llu", (long)getpid(), (unsigned long long)quarantine_sequence) >= (int)size) {
    die("cleanup quarantine name is too long");
  }
}

static void restore_quarantined_entry(int parent, const char *quarantine, const char *name, const char *failure) {
  if (renameatx_np(parent, quarantine, parent, name, RENAME_EXCL) != 0) die(failure);
}

static void quarantine_exact_entry(int parent, const char *name, const struct stat *expected, int retained,
                                   char *quarantine, size_t quarantine_size, const char *failure) {
  quarantine_name(quarantine, quarantine_size);
  if (renameatx_np(parent, name, parent, quarantine, RENAME_EXCL) != 0) die(failure);
  struct stat moved;
  struct stat opened;
  int valid = fstatat(parent, quarantine, &moved, AT_SYMLINK_NOFOLLOW) == 0 && same_identity(expected, &moved) &&
              expected->st_mode == moved.st_mode && expected->st_nlink == moved.st_nlink;
  if (retained >= 0) valid = valid && fstat(retained, &opened) == 0 && same_identity(expected, &opened) &&
                              expected->st_mode == opened.st_mode && expected->st_nlink == opened.st_nlink;
  if (!valid) {
    restore_quarantined_entry(parent, quarantine, name, failure);
    die(failure);
  }
}

static void cleanup_directory_contents(int directory) {
  int listing_fd = dup(directory);
  if (listing_fd < 0) die("cleanup directory descriptor duplication failed");
  DIR *listing = fdopendir(listing_fd);
  if (listing == NULL) die("cleanup directory traversal failed");
  rewinddir(listing);
  for (struct dirent *entry = readdir(listing); entry != NULL; entry = readdir(listing)) {
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    struct stat before;
    if (fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) != 0) die("cleanup entry disappeared");
    if (S_ISDIR(before.st_mode)) {
      int child = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      struct stat opened;
      if (child < 0 || fstat(child, &opened) != 0 || !same_version(&before, &opened)) die("cleanup directory changed before openat");
      char quarantine[512];
      quarantine_exact_entry(directory, name, &opened, child, quarantine, sizeof(quarantine), "cleanup directory was substituted");
      cleanup_directory_contents(child);
      struct stat final_descriptor;
      struct stat quarantined;
      if (fstat(child, &final_descriptor) != 0 || fstatat(directory, quarantine, &quarantined, AT_SYMLINK_NOFOLLOW) != 0 ||
          !same_identity(&opened, &final_descriptor) || !same_identity(&opened, &quarantined)) die("cleanup directory was substituted");
      if (close(child) != 0 || unlinkat(directory, quarantine, AT_REMOVEDIR) != 0) die("cleanup directory removal failed");
    } else if (S_ISREG(before.st_mode)) {
      if (before.st_nlink != 1) die("cleanup file link count is not exact");
      int retained = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      if (retained < 0) die("cleanup file openat failed");
      char quarantine[512];
      quarantine_exact_entry(directory, name, &before, retained, quarantine, sizeof(quarantine), "cleanup file was substituted");
      if (unlinkat(directory, quarantine, 0) != 0 || close(retained) != 0) die("cleanup file removal failed");
    } else {
      die("cleanup entry is not a regular file or directory");
    }
  }
  if (closedir(listing) != 0) die("cleanup directory enumeration failed");
}

static void cleanup_owned_tree(int parent, int target, const char *name) {
  struct stat opened;
  struct stat entry;
  if (fstat(target, &opened) != 0 || !S_ISDIR(opened.st_mode) ||
      fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&opened, &entry)) {
    die("cleanup target was substituted; retained output left fail-closed");
  }
  char quarantine[512];
  quarantine_exact_entry(parent, name, &opened, target, quarantine, sizeof(quarantine), "cleanup target was substituted; retained output left fail-closed");
  cleanup_directory_contents(target);
  struct stat final_descriptor;
  struct stat final_entry;
  if (fstat(target, &final_descriptor) != 0 || fstatat(parent, quarantine, &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_identity(&opened, &final_descriptor) || !same_identity(&opened, &final_entry)) die("cleanup target was substituted; retained output left fail-closed");
  if (unlinkat(parent, quarantine, AT_REMOVEDIR) != 0) die("cleanup target removal failed");
}

static int has_suffix(const char *value, const char *suffix) {
  size_t value_length = strlen(value);
  size_t suffix_length = strlen(suffix);
  return value_length >= suffix_length && strcmp(value + value_length - suffix_length, suffix) == 0;
}

static int is_distribution_diagnostic(const char *name) {
  return strcmp(name, "Packaging.log") == 0 || has_suffix(name, ".xcdistributionlogs");
}

static int safe_single_name(const char *name) {
  return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static int safe_relative_path(const char *path) {
  if (path[0] == '\0' || path[0] == '/') return 0;
  const char *component = path;
  for (const char *cursor = path;; cursor++) {
    if (*cursor == '/' || *cursor == '\0') {
      size_t length = (size_t)(cursor - component);
      if (length == 0 || (length == 1 && component[0] == '.') ||
          (length == 2 && component[0] == '.' && component[1] == '.')) return 0;
      if (*cursor == '\0') return 1;
      component = cursor + 1;
    }
  }
}

static void inject_cleanup_replacement_if_requested(int directory, const char *name, const char *relative_path, mode_t mode) {
  if (cleanup_inject_action == NULL || strcmp(relative_path, cleanup_inject_path) != 0) return;
  if (strcmp(cleanup_inject_action, "file-replacement") == 0) {
    if (!S_ISREG(mode) || unlinkat(directory, name, 0) != 0) die("cleanup file replacement injection failed");
    int replacement = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (replacement < 0 || write(replacement, "replacement-sentinel\n", 21) != 21 || fsync(replacement) != 0 || close(replacement) != 0) {
      die("cleanup file replacement injection failed");
    }
  } else if (strcmp(cleanup_inject_action, "directory-replacement") == 0) {
    if (!S_ISDIR(mode)) die("cleanup directory replacement target is not a directory");
    char replacement[512];
    if (snprintf(replacement, sizeof(replacement), ".cleanup-replaced-%ld", (long)getpid()) >= (int)sizeof(replacement)) die("cleanup injection path is too long");
    if (renameat(directory, name, directory, replacement) != 0 || mkdirat(directory, name, 0700) != 0) die("cleanup directory replacement injection failed");
    int sentinel_directory = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (sentinel_directory < 0) die("cleanup directory replacement injection failed");
    int sentinel = openat(sentinel_directory, "replacement-sentinel", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (sentinel < 0 || write(sentinel, "keep\n", 5) != 5 || fsync(sentinel) != 0 || close(sentinel) != 0 || close(sentinel_directory) != 0) {
      die("cleanup directory replacement injection failed");
    }
  } else if (strcmp(cleanup_inject_action, "file-after-quarantine") != 0 && strcmp(cleanup_inject_action, "directory-after-quarantine") != 0) {
    die("unknown cleanup injection action");
  }
}

static void inject_after_quarantine_if_requested(int directory, const char *name, const char *relative_path, mode_t mode) {
  if (cleanup_inject_action == NULL || strcmp(relative_path, cleanup_inject_path) != 0) return;
  if (strcmp(cleanup_inject_action, "file-after-quarantine") == 0) {
    if (!S_ISREG(mode)) die("post-quarantine file injection target is not regular");
    int replacement = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (replacement < 0 || write(replacement, "replacement-sentinel\n", 21) != 21 || fsync(replacement) != 0 || close(replacement) != 0) die("post-quarantine file injection failed");
  } else if (strcmp(cleanup_inject_action, "directory-after-quarantine") == 0) {
    if (!S_ISDIR(mode) || mkdirat(directory, name, 0700) != 0) die("post-quarantine directory injection failed");
    int replacement = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    int sentinel = replacement < 0 ? -1 : openat(replacement, "replacement-sentinel", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (sentinel < 0 || write(sentinel, "keep\n", 5) != 5 || fsync(sentinel) != 0 || close(sentinel) != 0 || close(replacement) != 0) die("post-quarantine directory injection failed");
  }
}

static void unlink_retained_regular_file(int parent, int retained, const char *name, const struct stat *expected, const char *failure) {
  struct stat opened;
  struct stat entry;
  if (fstat(retained, &opened) != 0 || !S_ISREG(opened.st_mode) || opened.st_nlink != 1 || !same_version(expected, &opened) ||
      fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(entry.st_mode) || !same_version(&opened, &entry)) {
    die(failure);
  }
  char quarantine[512];
  quarantine_exact_entry(parent, name, &opened, retained, quarantine, sizeof(quarantine), failure);
  if (unlinkat(parent, quarantine, 0) != 0) die("owned file removal failed");
}

static void cleanup_all_contents(int directory);

static void cleanup_entry(int directory, const char *name, const char *relative_path, const struct stat *before) {
  if (S_ISDIR(before->st_mode)) {
    int child = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    struct stat opened;
    if (child < 0 || fstat(child, &opened) != 0 || !same_version(before, &opened)) die("diagnostic directory changed before openat");
    inject_cleanup_replacement_if_requested(directory, name, relative_path, before->st_mode);
    char quarantine[512];
    quarantine_exact_entry(directory, name, &opened, child, quarantine, sizeof(quarantine), "diagnostic directory was substituted; replacement left intact");
    inject_after_quarantine_if_requested(directory, name, relative_path, before->st_mode);
    cleanup_all_contents(child);
    struct stat final_descriptor;
    struct stat final_entry;
    if (fstat(child, &final_descriptor) != 0 || fstatat(directory, quarantine, &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same_identity(&opened, &final_descriptor) || !same_identity(&opened, &final_entry)) {
      die("diagnostic directory was substituted; replacement left intact");
    }
    if (close(child) != 0 || unlinkat(directory, quarantine, AT_REMOVEDIR) != 0) die("diagnostic directory removal failed");
  } else if (S_ISREG(before->st_mode)) {
    int retained = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (retained < 0) die("diagnostic file openat failed");
    inject_cleanup_replacement_if_requested(directory, name, relative_path, before->st_mode);
    struct stat opened;
    if (fstat(retained, &opened) != 0 || opened.st_nlink != 1 || !same_version(before, &opened)) die("diagnostic file was substituted; replacement left intact");
    char quarantine[512];
    quarantine_exact_entry(directory, name, &opened, retained, quarantine, sizeof(quarantine), "diagnostic file was substituted; replacement left intact");
    inject_after_quarantine_if_requested(directory, name, relative_path, before->st_mode);
    if (unlinkat(directory, quarantine, 0) != 0) die("diagnostic file removal failed");
    if (close(retained) != 0) die("diagnostic file close failed");
  } else {
    die("diagnostic entry is not a regular file or directory; entry left intact");
  }
}

static void cleanup_all_contents(int directory) {
  int listing_fd = dup(directory);
  if (listing_fd < 0) die("diagnostic directory descriptor duplication failed");
  DIR *listing = fdopendir(listing_fd);
  if (listing == NULL) die("diagnostic directory traversal failed");
  rewinddir(listing);
  for (struct dirent *entry = readdir(listing); entry != NULL; entry = readdir(listing)) {
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    struct stat before;
    if (fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) != 0) die("diagnostic content disappeared");
    cleanup_entry(directory, name, name, &before);
  }
  if (closedir(listing) != 0) die("diagnostic directory enumeration failed");
}

static void cleanup_distribution_diagnostics(int directory, const char *prefix) {
  int listing_fd = dup(directory);
  if (listing_fd < 0) die("cleanup root descriptor duplication failed");
  DIR *listing = fdopendir(listing_fd);
  if (listing == NULL) die("cleanup root traversal failed");
  rewinddir(listing);
  for (struct dirent *entry = readdir(listing); entry != NULL; entry = readdir(listing)) {
    const char *name = entry->d_name;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
    char *relative_path = child_path(prefix, name);
    struct stat before;
    if (fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) != 0) die("cleanup entry disappeared");
    if (is_distribution_diagnostic(name)) {
      cleanup_entry(directory, name, relative_path, &before);
    } else if (S_ISDIR(before.st_mode)) {
      int child = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      struct stat opened;
      if (child < 0 || fstat(child, &opened) != 0 || !same_version(&before, &opened)) die("cleanup traversal directory changed before openat");
      cleanup_distribution_diagnostics(child, relative_path);
      struct stat final_descriptor;
      struct stat final_entry;
      if (fstat(child, &final_descriptor) != 0 || fstatat(directory, name, &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
          !same_identity(&opened, &final_descriptor) || !same_identity(&opened, &final_entry)) die("cleanup traversal directory was substituted");
      if (close(child) != 0) die("cleanup traversal directory close failed");
    }
    free(relative_path);
  }
  if (closedir(listing) != 0) die("cleanup root enumeration failed");
}

static void unlink_owned_file(int parent, int retained, const char *name) {
  struct stat opened;
  if (fstat(retained, &opened) != 0 || !S_ISREG(opened.st_mode)) die("owned file descriptor is not regular");
  unlink_retained_regular_file(parent, retained, name, &opened, "owned file was substituted; replacement left intact");
}

static void verify_retained_file(int parent, int retained, const char *name) {
  if (!safe_single_name(name)) die("OWNED_FILE_NAME_INVALID");
  struct stat entry;
  struct stat held;
  if (fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || fstat(retained, &held) != 0 || held.st_nlink != 1 ||
      !S_ISREG(entry.st_mode) || !S_ISREG(held.st_mode) || !same_version(&entry, &held)) die("OWNED_FILE_IDENTITY_INVALID");
}

static void ensure_directory_at(int parent, const char *name) {
  if (!safe_single_name(name)) die("DIRECTORY_NAME_INVALID");
  if (mkdirat(parent, name, 0700) != 0 && errno != EEXIST) die("DIRECTORY_CREATE_FAILED");
  struct stat entry;
  int opened = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat held;
  if (opened < 0 || fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || fstat(opened, &held) != 0 ||
      !S_ISDIR(entry.st_mode) || !same_version(&entry, &held)) die("DIRECTORY_IDENTITY_INVALID");
  if (close(opened) != 0) die("DIRECTORY_CLOSE_FAILED");
}

static void mkdir_owned_at(int parent, const char *name) {
  if (!safe_single_name(name)) die("DIRECTORY_NAME_INVALID");
  unsigned char nonce[16];
  arc4random_buf(nonce, sizeof(nonce));
  char encoded[sizeof(nonce) * 2 + 1];
  for (size_t index = 0; index < sizeof(nonce); index++) snprintf(encoded + index * 2, 3, "%02x", nonce[index]);
  char staged[512];
  if (snprintf(staged, sizeof(staged), ".directory-%ld-%s.tmp", (long)getpid(), encoded) >= (int)sizeof(staged)) die("DIRECTORY_NAME_INVALID");
  if (mkdirat(parent, staged, 0700) != 0) die("DIRECTORY_CREATE_FAILED");
  int opened = openat(parent, staged, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat held;
  struct stat staged_entry;
  if (opened < 0 || fstat(opened, &held) != 0 || fstatat(parent, staged, &staged_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(held.st_mode) || !same_version(&held, &staged_entry)) die("DIRECTORY_IDENTITY_INVALID");
  if (renameatx_np(parent, staged, parent, name, RENAME_EXCL) != 0) {
    char quarantine[512];
    quarantine_exact_entry(parent, staged, &held, opened, quarantine, sizeof(quarantine), "DIRECTORY_CREATE_FAILED");
    if (unlinkat(parent, quarantine, AT_REMOVEDIR) != 0 || close(opened) != 0) die("DIRECTORY_CREATE_FAILED");
    die("DIRECTORY_CREATE_FAILED");
  }
  struct stat entry;
  if (fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&held, &entry) ||
      held.st_mode != entry.st_mode || held.st_nlink != entry.st_nlink) die("DIRECTORY_IDENTITY_INVALID");
  printf("%llu\t%llu\n", (unsigned long long)held.st_dev, (unsigned long long)held.st_ino);
  if (close(opened) != 0) die("DIRECTORY_CLOSE_FAILED");
}

static void verify_retained_directory(int parent, int retained, const char *name) {
  if (!safe_single_name(name)) die("DIRECTORY_NAME_INVALID");
  struct stat entry;
  struct stat held;
  if (fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || fstat(retained, &held) != 0 ||
      !S_ISDIR(entry.st_mode) || !S_ISDIR(held.st_mode) || !same_identity(&entry, &held)) die("DIRECTORY_IDENTITY_INVALID");
}

static uint64_t parse_identity_number(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') die("DIRECTORY_IDENTITY_ARGUMENT_INVALID");
  return (uint64_t)parsed;
}

static int open_owned_directory(int parent, const char *name, const char *device, const char *inode) {
  if (!safe_single_name(name)) die("DIRECTORY_NAME_INVALID");
  int opened = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat held;
  if (opened < 0 || fstat(opened, &held) != 0 || !S_ISDIR(held.st_mode) ||
      (uint64_t)held.st_dev != parse_identity_number(device) || (uint64_t)held.st_ino != parse_identity_number(inode)) {
    die("DIRECTORY_IDENTITY_INVALID");
  }
  return opened;
}

static void publish_owned_file(int parent, int retained, const char *staged, const char *destination) {
  if (!safe_single_name(staged) || !safe_single_name(destination)) die("PUBLICATION_NAME_INVALID");
  struct stat held;
  struct stat staged_entry;
  if (fstat(retained, &held) != 0 || held.st_nlink != 1 || !S_ISREG(held.st_mode) ||
      fstatat(parent, staged, &staged_entry, AT_SYMLINK_NOFOLLOW) != 0 || !same_version(&held, &staged_entry)) die("PUBLICATION_STAGED_IDENTITY_INVALID");
  if (linkat(parent, staged, parent, destination, 0) != 0) die("PUBLICATION_NO_CLOBBER_FAILED");
  struct stat published;
  if (fstatat(parent, destination, &published, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&held, &published)) die("PUBLICATION_IDENTITY_INVALID");
  if (unlinkat(parent, staged, 0) != 0) die("PUBLICATION_STAGED_CLEANUP_FAILED");
}

static void publish_stdin_file(int parent, const char *destination) {
  if (!safe_single_name(destination)) die("PUBLICATION_NAME_INVALID");
  int output = openat(parent, destination, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (output < 0) die("PUBLICATION_NO_CLOBBER_FAILED");
  unsigned char buffer[65536];
  uint64_t total = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0 || total + (uint64_t)(count > 0 ? count : 0) > 16ULL * 1024ULL * 1024ULL) {
      close(output); die("PUBLICATION_INPUT_INVALID");
    }
    if (count == 0) break;
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(output, buffer + offset, (size_t)(count - offset));
      if (written <= 0) { close(output); die("PUBLICATION_WRITE_FAILED"); }
      offset += written;
    }
    total += (uint64_t)count;
  }
  struct stat held;
  if (fsync(output) != 0 || fstat(output, &held) != 0 || held.st_nlink != 1) die("PUBLICATION_WRITE_FAILED");
  struct stat published;
  if (fstatat(parent, destination, &published, AT_SYMLINK_NOFOLLOW) != 0 || !same_version(&held, &published)) die("PUBLICATION_IDENTITY_INVALID");
  if (close(output) != 0) die("PUBLICATION_WRITE_FAILED");
}

static void copy_file(int source_directory, int destination_directory, const char *name, const char *relative_path, const struct stat *before) {
  if (before->st_nlink != 1) die("HARDLINK_FORBIDDEN");
  if (before->st_size < 0 || (uint64_t)before->st_size > MAX_FILE_BYTES) die("RESOURCE_FILE_LIMIT");
  if (inventory_total_bytes > MAX_TOTAL_BYTES - (uint64_t)before->st_size) die("RESOURCE_TOTAL_LIMIT");
  inventory_total_bytes += (uint64_t)before->st_size;
  int source = openat(source_directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (source < 0) die("regular file open failed after lstat");
  struct stat opened;
  if (fstat(source, &opened) != 0 || !S_ISREG(opened.st_mode) || !same_version(before, &opened)) die("regular file identity changed before open");
  int destination = openat(destination_directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, opened.st_mode & 0777);
  if (destination < 0) die("snapshot regular file creation failed");
  CC_SHA256_CTX digest;
  CC_SHA256_Init(&digest);
  uint64_t total = 0;
  unsigned char buffer[65536];
  for (;;) {
    enforce_deadline();
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0) die("regular file read failed");
    if (count == 0) break;
    CC_SHA256_Update(&digest, buffer, (CC_LONG)count);
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(destination, buffer + offset, (size_t)(count - offset));
      if (written <= 0) die("snapshot regular file write failed");
      offset += written;
    }
    total += (uint64_t)count;
  }
  struct stat final_descriptor;
  struct stat final_entry;
  if (fstat(source, &final_descriptor) != 0 || fstatat(source_directory, name, &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_version(before, &final_descriptor) || !same_version(before, &final_entry) || !S_ISREG(final_entry.st_mode) ||
      opened.st_size != final_descriptor.st_size || (uint64_t)final_descriptor.st_size != total ||
      opened.st_mtimespec.tv_sec != final_descriptor.st_mtimespec.tv_sec || opened.st_mtimespec.tv_nsec != final_descriptor.st_mtimespec.tv_nsec ||
      opened.st_ctimespec.tv_sec != final_descriptor.st_ctimespec.tv_sec || opened.st_ctimespec.tv_nsec != final_descriptor.st_ctimespec.tv_nsec) {
    die("regular file changed or was replaced while reading");
  }
  if (fsync(destination) != 0 || close(destination) != 0 || close(source) != 0) die("regular file descriptor close failed");
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(hash, &digest);
  printf("F\t%o\t%llu\t", opened.st_mode & 0777, (unsigned long long)total);
  for (size_t index = 0; index < sizeof(hash); index++) printf("%02x", hash[index]);
  printf("\t");
  print_hex(relative_path);
  printf("\n");
}

static void walk_directory(int source_directory, int destination_directory, const char *prefix) {
  int listing_fd = dup(source_directory);
  if (listing_fd < 0) die("directory descriptor duplication failed");
  DIR *listing = fdopendir(listing_fd);
  if (listing == NULL) die("directory descriptor traversal failed");
  rewinddir(listing);
  size_t count = 0;
  size_t capacity = 32;
  char **names = calloc(capacity, sizeof(char *));
  if (names == NULL) die("allocation failed");
  errno = 0;
  for (struct dirent *entry = readdir(listing); entry != NULL; entry = readdir(listing)) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (count == capacity) {
      capacity *= 2;
      char **grown = realloc(names, capacity * sizeof(char *));
      if (grown == NULL) die("allocation failed");
      names = grown;
    }
    names[count] = strdup(entry->d_name);
    if (names[count++] == NULL) die("allocation failed");
  }
  if (errno != 0 || closedir(listing) != 0) die("directory enumeration failed");
  qsort(names, count, sizeof(char *), compare_names);
  for (size_t index = 0; index < count; index++) {
    enforce_deadline();
    if (++inventory_entries > MAX_ENTRIES) die("RESOURCE_ENTRY_LIMIT");
    const char *name = names[index];
    char *relative_path = child_path(prefix, name);
    struct stat before;
    if (fstatat(source_directory, name, &before, AT_SYMLINK_NOFOLLOW) != 0) die("directory entry disappeared before inspection");
    inject_if_requested(source_directory, name, relative_path, before.st_mode);
    if (S_ISLNK(before.st_mode)) die("symlink is forbidden");
    if (S_ISDIR(before.st_mode)) {
      int child = openat(source_directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child < 0) die("directory open failed after lstat");
      struct stat opened;
      if (fstat(child, &opened) != 0 || !S_ISDIR(opened.st_mode) || !same_version(&before, &opened)) die("directory identity changed before open");
      if (mkdirat(destination_directory, name, opened.st_mode & 0777) != 0) die("snapshot directory creation failed");
      int destination_child = openat(destination_directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (destination_child < 0) die("snapshot directory open failed");
      printf("D\t%o\t", opened.st_mode & 0777);
      print_hex(relative_path);
      printf("\n");
      walk_directory(child, destination_child, relative_path);
      struct stat final_descriptor;
      struct stat final_entry;
      if (fstat(child, &final_descriptor) != 0 || fstatat(source_directory, name, &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
          !same_version(&before, &final_descriptor) || !same_version(&before, &final_entry) || !S_ISDIR(final_entry.st_mode)) {
        die("directory changed or was replaced during traversal");
      }
      if (close(destination_child) != 0 || close(child) != 0) die("directory descriptor close failed");
    } else if (S_ISREG(before.st_mode)) {
      copy_file(source_directory, destination_directory, name, relative_path, &before);
    } else {
      die("special file is forbidden");
    }
    free(relative_path);
    free(names[index]);
  }
  free(names);
}

#ifdef GREENROOM_NODE_ADDON
static napi_value openat_directory_binding(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) return NULL;
  int32_t parent;
  size_t length;
  if (napi_get_value_int32(env, argv[0], &parent) != napi_ok || napi_get_value_string_utf8(env, argv[1], NULL, 0, &length) != napi_ok || length == 0 || length > 255) return NULL;
  char name[256];
  if (napi_get_value_string_utf8(env, argv[1], name, sizeof(name), &length) != napi_ok || !safe_single_name(name)) return NULL;
  int opened = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (opened < 0) {
    napi_throw_error(env, "RETAINED_DIRECTORY_OPEN_FAILED", "descriptor-relative directory open failed");
    return NULL;
  }
  napi_value result;
  if (napi_create_int32(env, opened, &result) != napi_ok) { close(opened); return NULL; }
  return result;
}

static napi_value publish_at_binding(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3) return NULL;
  int32_t parent;
  size_t name_length;
  void *bytes;
  size_t byte_length;
  if (napi_get_value_int32(env, argv[0], &parent) != napi_ok ||
      napi_get_value_string_utf8(env, argv[1], NULL, 0, &name_length) != napi_ok || name_length == 0 || name_length > 255 ||
      napi_get_buffer_info(env, argv[2], &bytes, &byte_length) != napi_ok || byte_length > 16ULL * 1024ULL * 1024ULL) return NULL;
  char name[256];
  if (napi_get_value_string_utf8(env, argv[1], name, sizeof(name), &name_length) != napi_ok || !safe_single_name(name)) return NULL;
  int output = openat(parent, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (output < 0) {
    napi_throw_error(env, "PUBLICATION_NO_CLOBBER_FAILED", "descriptor-relative exclusive publication failed");
    return NULL;
  }
  size_t offset = 0;
  while (offset < byte_length) {
    ssize_t written = write(output, (unsigned char *)bytes + offset, byte_length - offset);
    if (written <= 0) {
      close(output);
      napi_throw_error(env, "PUBLICATION_WRITE_FAILED", "descriptor-relative publication write failed");
      return NULL;
    }
    offset += (size_t)written;
  }
  struct stat held;
  struct stat entry;
  if (fsync(output) != 0 || fstat(output, &held) != 0 || held.st_nlink != 1 ||
      fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 || !same_version(&held, &entry)) {
    close(output);
    napi_throw_error(env, "PUBLICATION_IDENTITY_INVALID", "descriptor-relative publication identity failed");
    return NULL;
  }
  napi_value result;
  if (napi_create_int32(env, output, &result) != napi_ok) { close(output); return NULL; }
  return result;
}

static napi_value initialize_binding(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "openatDirectory", NAPI_AUTO_LENGTH, openat_directory_binding, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "openatDirectory", function) != napi_ok) return NULL;
  if (napi_create_function(env, "publishAt", NAPI_AUTO_LENGTH, publish_at_binding, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "publishAt", function) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize_binding)
#else
int main(int argc, char **argv) {
  if (clock_gettime(CLOCK_MONOTONIC, &inventory_started) != 0) die("RESOURCE_CLOCK_FAILED");
  if (argc >= 3 && strcmp(argv[1], "exec-at-fd") == 0) {
    if (fchdir(3) != 0) die("COMMAND_DIRECTORY_INVALID");
    execv(argv[2], &argv[2]);
    die("COMMAND_EXEC_FAILED");
  }
  if (argc == 3 && strcmp(argv[1], "read-file-fd") == 0) {
    read_file_at(3, argv[2], 0);
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "read-file-inplace-test-fd") == 0) {
    read_file_at(3, argv[2], 1);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "cleanup-tree-fds") == 0) {
    cleanup_owned_tree(3, 4, argv[2]);
    return 0;
  }
  if (argc == 5 && strcmp(argv[1], "cleanup-tree-owner-fd") == 0) {
    int target = open_owned_directory(3, argv[2], argv[3], argv[4]);
    cleanup_owned_tree(3, target, argv[2]);
    if (close(target) != 0) die("cleanup target close failed");
    return 0;
  }
  if ((argc == 2 || argc == 4) && strcmp(argv[1], "cleanup-diagnostics-fd") == 0) {
    if (argc == 4) {
      if ((strcmp(argv[2], "file-replacement") != 0 && strcmp(argv[2], "directory-replacement") != 0 &&
           strcmp(argv[2], "file-after-quarantine") != 0 && strcmp(argv[2], "directory-after-quarantine") != 0) || !safe_relative_path(argv[3])) {
        die("cleanup injection request is not closed");
      }
      cleanup_inject_action = argv[2];
      cleanup_inject_path = argv[3];
    }
    cleanup_distribution_diagnostics(3, "");
    return 0;
  }
  if ((argc == 5 || argc == 7) && strcmp(argv[1], "cleanup-diagnostics-owner-fd") == 0) {
    int target = open_owned_directory(3, argv[2], argv[3], argv[4]);
    if (argc == 7) {
      if ((strcmp(argv[5], "file-replacement") != 0 && strcmp(argv[5], "directory-replacement") != 0 &&
           strcmp(argv[5], "file-after-quarantine") != 0 && strcmp(argv[5], "directory-after-quarantine") != 0) || !safe_relative_path(argv[6])) die("cleanup injection request is not closed");
      cleanup_inject_action = argv[5];
      cleanup_inject_path = argv[6];
    }
    cleanup_distribution_diagnostics(target, "");
    if (close(target) != 0) die("diagnostic root close failed");
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "unlink-owned-file-fds") == 0) {
    if (!safe_single_name(argv[2])) die("owned file name is unsafe");
    unlink_owned_file(3, 4, argv[2]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "verify-file-fds") == 0) {
    verify_retained_file(3, 4, argv[2]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "ensure-directory-fd") == 0) {
    ensure_directory_at(3, argv[2]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "mkdirat-fd") == 0) {
    mkdir_owned_at(3, argv[2]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "verify-directory-fds") == 0) {
    verify_retained_directory(3, 4, argv[2]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "describe-directory-fd") == 0) {
    if (!safe_single_name(argv[2])) die("DIRECTORY_NAME_INVALID");
    int opened = openat(3, argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    struct stat held;
    if (opened < 0 || fstat(opened, &held) != 0 || !S_ISDIR(held.st_mode)) die("DIRECTORY_IDENTITY_INVALID");
    printf("%llu\t%llu\n", (unsigned long long)held.st_dev, (unsigned long long)held.st_ino);
    if (close(opened) != 0) die("DIRECTORY_CLOSE_FAILED");
    return 0;
  }
  if (argc == 5 && strcmp(argv[1], "verify-directory-owner-fd") == 0) {
    int opened = open_owned_directory(3, argv[2], argv[3], argv[4]);
    if (close(opened) != 0) die("DIRECTORY_CLOSE_FAILED");
    return 0;
  }
  if ((argc == 6 || argc == 9) && strcmp(argv[1], "snapshot-directory-owner-fd") == 0) {
    int source = open_owned_directory(3, argv[2], argv[3], argv[4]);
    int destination = open(argv[5], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (destination < 0) die("snapshot destination open failed");
    if (argc == 9) { inject_action = argv[6]; inject_path = argv[7]; inject_target = argv[8]; }
    walk_directory(source, destination, "");
    struct stat final_descriptor;
    struct stat final_entry;
    if (fstat(source, &final_descriptor) != 0 || fstatat(3, argv[2], &final_entry, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same_identity(&final_descriptor, &final_entry) || (uint64_t)final_descriptor.st_dev != parse_identity_number(argv[3]) ||
        (uint64_t)final_descriptor.st_ino != parse_identity_number(argv[4])) die("root changed or was replaced during traversal");
    if (close(destination) != 0 || close(source) != 0) die("root descriptor close failed");
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "publish-file-fds") == 0) {
    publish_owned_file(3, 4, argv[2], argv[3]);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "publish-stdin-fd") == 0) {
    publish_stdin_file(3, argv[2]);
    return 0;
  }
  if (argc != 3 && argc != 6) die("usage: helper ROOT SNAPSHOT [ACTION RELATIVE_PATH TARGET]");
  if (argc == 6) {
    inject_action = argv[3];
    inject_path = argv[4];
    inject_target = argv[5];
  }
  struct stat before;
  if (lstat(argv[1], &before) != 0 || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode)) die("root must be a real directory");
  int source = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int destination = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat opened;
  if (source < 0 || destination < 0 || fstat(source, &opened) != 0 || !same_version(&before, &opened)) die("root identity changed before open");
  walk_directory(source, destination, "");
  struct stat final_descriptor;
  struct stat final_entry;
  if (fstat(source, &final_descriptor) != 0 || lstat(argv[1], &final_entry) != 0 || !same_version(&before, &final_descriptor) ||
      !same_version(&before, &final_entry) || !S_ISDIR(final_entry.st_mode) || S_ISLNK(final_entry.st_mode)) die("root changed or was replaced during traversal");
  if (close(destination) != 0 || close(source) != 0) die("root descriptor close failed");
  return 0;
}
#endif
