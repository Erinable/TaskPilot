CC ?= cc
CFLAGS ?= -Wall -Wextra -O1
LDLIBS = -pthread
PROGRAMS = build/pingpong build/copy build/counter build/bbuf

all: $(PROGRAMS)

build/%: src/%.c
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

# Always from a clean build: make compares file times to the second on some
# systems, so a source saved just after the last build could be graded stale.
grade:
	@$(MAKE) -s clean
	@$(MAKE) -s all
	@sh tests/grade.sh

clean:
	rm -rf build

.PHONY: all grade clean
