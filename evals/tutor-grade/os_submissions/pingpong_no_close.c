// Lab 1, ping-pong: the parent sends one byte to a child over a pipe; the
// child prints "<pid>: received ping" and sends the byte back; the parent
// then prints "<pid>: received pong" and waits for the child.
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  int p1[2], p2[2];
  char c = 'x';
  pipe(p1);
  pipe(p2);
  if (fork() == 0) {
    read(p1[0], &c, 1);
    printf("%d: received ping\n", getpid());
    fflush(stdout);
    write(p2[1], &c, 1);
    return 0;
  }
  write(p1[1], &c, 1);
  read(p2[0], &c, 1);
  printf("%d: received pong\n", getpid());
  return 0;
}
