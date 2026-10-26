// First come, first served: reads "name arrival burst" lines from standard
// input and prints "name finish" for each job as it finishes.
#include <stdio.h>

#define MAX_JOBS 64

struct job {
  char name[16];
  int arrival;
  int burst;
};

static int read_jobs(struct job *jobs) {
  int count = 0;
  while (count < MAX_JOBS && scanf("%15s %d %d", jobs[count].name, &jobs[count].arrival, &jobs[count].burst) == 3) count++;
  return count;
}

// TODO: run the jobs in arrival order (input order on a tie). The CPU idles
// until the next job arrives. Print "name finish" as each job finishes.
static void fcfs(struct job *jobs, int count) {
  (void)jobs;
  (void)count;
}

int main(void) {
  struct job jobs[MAX_JOBS];
  fcfs(jobs, read_jobs(jobs));
  return 0;
}
