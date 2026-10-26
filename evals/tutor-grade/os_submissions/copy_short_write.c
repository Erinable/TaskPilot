// Lab 2, copy: `copy SRC DST` copies a file with open, read and write only.
// It exits 1 with a message when a call fails.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  int in = open(argv[1], O_RDONLY);
  if (in < 0) {
    perror(argv[1]);
    return 1;
  }
  int out = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (out < 0) {
    perror(argv[2]);
    return 1;
  }
  char buf[4096];
  ssize_t n;
  while ((n = read(in, buf, sizeof buf)) > 0) write(out, buf, n);
  close(in);
  close(out);
  return 0;
}
