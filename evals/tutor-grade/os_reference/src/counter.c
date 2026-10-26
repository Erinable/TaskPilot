// Lab 3, counter: `counter THREADS ITERS` starts THREADS threads that each add
// 1 to a shared counter ITERS times, then prints the total.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static long counter = 0;
static long iterations = 0;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *arg) {
  (void)arg;
  for (long i = 0; i < iterations; i++) {
    // counter++ is a load, an add and a store; without the lock two threads
    // can load the same value and one increment is lost.
    pthread_mutex_lock(&lock);
    counter++;
    pthread_mutex_unlock(&lock);
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: counter THREADS ITERS\n");
    return 1;
  }
  int threads = atoi(argv[1]);
  iterations = atol(argv[2]);
  if (threads < 1 || threads > 64 || iterations < 0) {
    fprintf(stderr, "counter: THREADS must be 1 to 64 and ITERS at least 0\n");
    return 1;
  }
  pthread_t ids[64];
  for (int i = 0; i < threads; i++)
    if (pthread_create(&ids[i], NULL, worker, NULL) != 0) {
      fprintf(stderr, "counter: pthread_create failed\n");
      return 1;
    }
  for (int i = 0; i < threads; i++) pthread_join(ids[i], NULL);
  printf("%ld\n", counter);
  return 0;
}
