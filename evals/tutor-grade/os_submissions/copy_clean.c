// Lab 2, copy: `copy SRC DST` copies a file with open, read and write only.
// It exits 1 with a message when a call fails.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

// Writes all of buf, since write() may write less than asked.
static int write_fully(int fd, const char *buf, ssize_t len) {
  ssize_t done = 0;
  while (done < len) {
    ssize_t n = write(fd, buf + done, (size_t)(len - done));
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) return -1;
    done += n;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: copy SRC DST\n");
    return 1;
  }
  int src = open(argv[1], O_RDONLY);
  if (src < 0) {
    perror(argv[1]);
    return 1;
  }
  int dst = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (dst < 0) {
    perror(argv[2]);
    close(src);
    return 1;
  }
  char buf[8192];
  int status = 0;
  for (;;) {
    ssize_t n = read(src, buf, sizeof buf);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      if (n < 0) {
        perror("read");
        status = 1;
      }
      break;
    }
    if (write_fully(dst, buf, n) < 0) {
      perror("write");
      status = 1;
      break;
    }
  }
  close(src);
  if (close(dst) < 0) {
    perror("close");
    status = 1;
  }
  return status;
}
