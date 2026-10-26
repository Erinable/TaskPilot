CC ?= cc
CFLAGS ?= -Wall -Wextra -O1
LDLIBS = -pthread
PROGRAMS = build/pingpong build/copy build/counter build/bbuf

all: $(PROGRAMS)

build/%: src/%.c
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

grade: all
	@sh tests/grade.sh

clean:
	rm -rf build

.PHONY: all grade clean
