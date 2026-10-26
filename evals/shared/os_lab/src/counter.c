// Lab 3, counter: `counter THREADS ITERS` starts THREADS threads that each add
// 1 to a shared counter ITERS times, then prints the total.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static long counter = 0;

int main(int argc, char **argv) {
  // TODO: lab 3
  (void)argc;
  (void)argv;
  printf("%ld\n", counter);
  return 1;
}
