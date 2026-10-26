# Lab 1: first come, first served

`build/fcfs` reads jobs from standard input, one per line: `name arrival burst`
(whole numbers of ticks). Run them one at a time in arrival order; two jobs
that arrive together run in input order. When no job is waiting, the CPU
idles until the next one arrives.

Print `name finish` for each job as it finishes, one per line.

Fill in `fcfs()` in `src/fcfs.c`. `make grade` runs the tests.
