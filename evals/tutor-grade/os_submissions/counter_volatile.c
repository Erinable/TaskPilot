// Lab 3, counter: `counter THREADS ITERS` starts THREADS threads that each add
// 1 to a shared counter ITERS times, then prints the total.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

// volatile so every thread sees the latest value; no lock needed.
static volatile long counter = 0;
static long iterations = 0;

static void *worker(void *arg) {
  (void)arg;
  for (long i = 0; i < iterations; i++) counter++;
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  int threads = atoi(argv[1]);
  iterations = atol(argv[2]);
  pthread_t ids[64];
  for (int i = 0; i < threads; i++) pthread_create(&ids[i], NULL, worker, NULL);
  for (int i = 0; i < threads; i++) pthread_join(ids[i], NULL);
  printf("%ld\n", counter);
  return 0;
}
