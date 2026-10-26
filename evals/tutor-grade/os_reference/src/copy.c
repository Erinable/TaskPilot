// Lab 2, copy: `copy SRC DST` copies a file with open, read and write only.
// It exits 1 with a message when a call fails.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

// write() may write fewer bytes than asked (a pipe, a signal, a full disk),
// so loop until the whole buffer is out; retry when a signal interrupted it.
static int write_all(int fd, const char *buf, ssize_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, (size_t)len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    buf += n;
    len -= n;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: copy SRC DST\n");
    return 1;
  }
  int in = open(argv[1], O_RDONLY);
  if (in < 0) {
    perror(argv[1]);
    return 1;
  }
  int out = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (out < 0) {
    perror(argv[2]);
    close(in);
    return 1;
  }
  char buf[4096];
  int failed = 0;
  for (;;) {
    ssize_t n = read(in, buf, sizeof buf);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) {
      perror("read");
      failed = 1;
      break;
    }
    if (n == 0) break;
    if (write_all(out, buf, n) < 0) {
      perror("write");
      failed = 1;
      break;
    }
  }
  close(in);
  // close() reports a delayed write error, e.g. on a network file system.
  if (close(out) < 0) {
    perror("close");
    failed = 1;
  }
  return failed;
}
