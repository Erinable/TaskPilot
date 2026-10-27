// Round robin: reads a time slice, then "name arrival burst" lines, and
// prints "name finish" for each job as it finishes.
#include <stdio.h>

#define MAX_JOBS 64

struct job {
  char name[16];
  int arrival;
  int left;
};

static int read_jobs(struct job *jobs) {
  int count = 0;
  while (count < MAX_JOBS && scanf("%15s %d %d", jobs[count].name, &jobs[count].arrival, &jobs[count].left) == 3) count++;
  return count;
}

// TODO: give each job in the ready queue at most `slice` ticks in turn. Jobs
// that arrive while one runs join the queue before it goes back to the end.
static void rr(struct job *jobs, int count, int slice) {
  (void)jobs;
  (void)count;
  (void)slice;
}

int main(void) {
  int slice;
  if (scanf("%d", &slice) != 1 || slice < 1) return 1;
  struct job jobs[MAX_JOBS];
  rr(jobs, read_jobs(jobs), slice);
  return 0;
}
