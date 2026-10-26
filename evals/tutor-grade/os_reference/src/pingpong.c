// Lab 1, ping-pong: the parent sends one byte to a child over a pipe; the
// child prints "<pid>: received ping" and sends the byte back; the parent
// then prints "<pid>: received pong" and waits for the child.
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  int to_child[2], to_parent[2];
  char byte = 'p';
  if (pipe(to_child) < 0 || pipe(to_parent) < 0) {
    perror("pipe");
    return 1;
  }
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 1;
  }
  if (pid == 0) {
    // Each side closes the ends it does not use, so a read sees EOF when
    // the other side exits instead of blocking forever.
    close(to_child[1]);
    close(to_parent[0]);
    if (read(to_child[0], &byte, 1) != 1) return 1;
    printf("%d: received ping\n", getpid());
    fflush(stdout);
    if (write(to_parent[1], &byte, 1) != 1) return 1;
    return 0;
  }
  close(to_child[0]);
  close(to_parent[1]);
  if (write(to_child[1], &byte, 1) != 1) return 1;
  if (read(to_parent[0], &byte, 1) != 1) return 1;
  printf("%d: received pong\n", getpid());
  // Reap the child so it does not stay a zombie.
  int status;
  if (waitpid(pid, &status, 0) < 0) return 1;
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 1;
}
