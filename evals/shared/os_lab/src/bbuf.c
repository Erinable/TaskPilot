// Lab 4, bounded buffer: `bbuf CONSUMERS ITEMS` has one producer put the
// numbers 1..ITEMS into an 8-slot buffer and CONSUMERS threads take them out
// and add them up. It prints the sum. A consumer that takes 0 stops.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define SLOTS 8

static long slots[SLOTS];
static int head = 0, tail = 0, count = 0;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t not_empty = PTHREAD_COND_INITIALIZER;
static pthread_cond_t not_full = PTHREAD_COND_INITIALIZER;

// TODO: lab 4, put() and take()

int main(int argc, char **argv) {
  // TODO: lab 4
  (void)argc;
  (void)argv;
  return 1;
}
