<script setup lang="ts">
// Project conventions and gaps Architect noted, each with its requirement.
import InlineCode from '@/components/InlineCode.vue';
import type * as activityTypes from '@shared/ipc/activity.ts';
import { sourceDate } from './map_wording.ts';

const props = defineProps<{ title: string; kind: 'conventions' | 'gaps'; notes: activityTypes.MapNote[]; timeZone: string }>();
const emit = defineEmits<{ source: [requirementId: string] }>();
</script>

<template>
  <section class="panel glass map-notes" :data-notes="props.kind">
    <div class="panel-heading">
      <div>
        <h2>{{ props.title }}</h2>
      </div>
      <span class="tag">{{ props.notes.length }}</span>
    </div>
    <p v-if="props.notes.length === 0" class="empty-hint">暂无</p>
    <ul v-else class="map-notes-items">
      <li v-for="note in props.notes" :key="note.text" class="map-note">
        <span class="map-note-text"><InlineCode :text="note.text" /></span>
        <button type="button" class="map-note-source" @click="emit('source', note.source.requirementId)">
          来自需求「{{ note.source.title }}」· {{ sourceDate(note.source.at, props.timeZone) }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.map-notes-items {
  margin: 0;
  padding: 0 20px 18px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.map-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.map-note-text {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.map-note-source {
  align-self: flex-start;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
  text-align: left;
}
.map-note-source:hover {
  color: var(--accent-strong);
  text-decoration: underline;
}
.empty-hint,
.tag {
  font-size: var(--text-sm);
}
</style>
