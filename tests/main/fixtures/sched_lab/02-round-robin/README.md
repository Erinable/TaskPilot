# Lab 2: round robin

`build/rr` reads a time slice on the first line, then jobs as in lab 1:
`name arrival burst`. Jobs take turns from a ready queue, each running for
at most one time slice. A job that arrives while another runs joins the
queue before the running job goes back to its end. When the queue is empty,
the CPU idles until the next job arrives.

Print `name finish` for each job as it finishes, one per line.

Fill in `rr()` in `src/rr.c`. `make grade` runs this lab's tests and lab 1's.
