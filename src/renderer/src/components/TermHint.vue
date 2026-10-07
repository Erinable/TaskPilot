<script setup lang="ts">
// A term with a small "?" that explains it in plain words, on hover or focus.
import { GLOSSARY } from '@/lib/glossary.ts';
import type { GlossaryKey } from '@/lib/glossary.ts';

const props = defineProps<{ term: GlossaryKey; label?: string }>();
const entry = GLOSSARY[props.term];
</script>

<template>
  <span class="term-hint">
    <slot>{{ label ?? entry.term }}</slot>
    <el-tooltip :content="entry.meaning" placement="top" :show-after="150" popper-class="term-tooltip">
      <button class="term-mark" type="button" :aria-label="`${entry.term}是什么？${entry.meaning}`">?</button>
    </el-tooltip>
  </span>
</template>
