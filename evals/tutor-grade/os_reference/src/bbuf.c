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

static long total = 0;

// Waits re-check their condition in a loop: a wakeup only means the state
// may have changed, and another thread may have taken the slot first.
static void put(long value) {
  pthread_mutex_lock(&lock);
  while (count == SLOTS) pthread_cond_wait(&not_full, &lock);
  slots[tail] = value;
  tail = (tail + 1) % SLOTS;
  count++;
  pthread_cond_signal(&not_empty);
  pthread_mutex_unlock(&lock);
}

static long take(void) {
  pthread_mutex_lock(&lock);
  while (count == 0) pthread_cond_wait(&not_empty, &lock);
  long value = slots[head];
  head = (head + 1) % SLOTS;
  count--;
  pthread_cond_signal(&not_full);
  pthread_mutex_unlock(&lock);
  return value;
}

static void *consumer(void *arg) {
  (void)arg;
  long sum = 0;
  for (long value; (value = take()) != 0;) sum += value;
  pthread_mutex_lock(&lock);
  total += sum;
  pthread_mutex_unlock(&lock);
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: bbuf CONSUMERS ITEMS\n");
    return 1;
  }
  int consumers = atoi(argv[1]);
  long items = atol(argv[2]);
  if (consumers < 1 || consumers > 64 || items < 0) {
    fprintf(stderr, "bbuf: CONSUMERS must be 1 to 64 and ITEMS at least 0\n");
    return 1;
  }
  pthread_t ids[64];
  for (int i = 0; i < consumers; i++)
    if (pthread_create(&ids[i], NULL, consumer, NULL) != 0) {
      fprintf(stderr, "bbuf: pthread_create failed\n");
      return 1;
    }
  for (long value = 1; value <= items; value++) put(value);
  // One 0 per consumer tells each of them to stop.
  for (int i = 0; i < consumers; i++) put(0);
  for (int i = 0; i < consumers; i++) pthread_join(ids[i], NULL);
  printf("%ld\n", total);
  return 0;
}
