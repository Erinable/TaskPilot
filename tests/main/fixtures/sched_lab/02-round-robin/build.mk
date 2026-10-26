CC ?= cc
CFLAGS ?= -Wall -Wextra -O1

build: build/fcfs build/rr

build/%: src/%.c
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -rf build

.PHONY: build clean
