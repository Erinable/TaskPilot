<script setup lang="ts">
// One summarized module: purpose, members, dependencies and where it came from.
import InlineCode from '@/components/InlineCode.vue';
import type * as ipc from '@shared/ipc_types.ts';
import { FRESHNESS, sourceDate } from './map_wording.ts';

const props = defineProps<{ module: ipc.MapModule; known: Set<string>; timeZone: string }>();
const emit = defineEmits<{ select: [path: string]; source: [requirementId: string] }>();
</script>

<template>
  <article class="map-detail" data-detail>
    <header class="map-detail-header">
      <code class="map-detail-path">{{ props.module.path }}</code>
      <span class="status-pill map-freshness" :class="FRESHNESS[props.module.freshness].tone" :data-freshness="props.module.freshness">
        {{ FRESHNESS[props.module.freshness].label }}
      </span>
    </header>
    <p class="map-detail-purpose"><InlineCode :text="props.module.purpose" /></p>

    <section v-if="props.module.members.length" class="map-detail-section">
      <h3>成员</h3>
      <ul class="map-members">
        <li v-for="member in props.module.members" :key="member.name" class="map-member">
          <code class="map-member-name">{{ member.name }}</code>
          <code class="map-member-signature">{{ member.signature }}</code>
        </li>
      </ul>
    </section>

    <section v-if="props.module.dependsOn.length" class="map-detail-section">
      <h3>依赖</h3>
      <ul class="map-depends">
        <li v-for="dependency in props.module.dependsOn" :key="dependency">
          <button
            v-if="props.known.has(dependency)"
            type="button"
            class="map-depend-link"
            :data-depend="dependency"
            :aria-label="`查看 ${dependency}`"
            @click="emit('select', dependency)"
          >
            <code>{{ dependency }}</code>
          </button>
          <code v-else class="map-depend-plain">{{ dependency }}</code>
        </li>
      </ul>
    </section>

    <section v-if="props.module.notes.length" class="map-detail-section">
      <h3>备注</h3>
      <ul class="map-notes-list">
        <li v-for="(note, index) in props.module.notes" :key="index"><InlineCode :text="note" /></li>
      </ul>
    </section>

    <footer class="map-detail-source">
      <button type="button" class="map-source-link" data-source @click="emit('source', props.module.source.requirementId)">
        来自需求「{{ props.module.source.title }}」· {{ sourceDate(props.module.source.at, props.timeZone) }}
      </button>
    </footer>
  </article>
</template>

<style scoped>
.map-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 20px 20px;
}
.map-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.map-detail-path {
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 600;
  word-break: break-all;
}
.map-freshness {
  font-size: var(--text-sm);
}
.map-detail-purpose {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.map-detail-section h3 {
  margin: 0 0 8px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 600;
}
.map-detail-section ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.map-member {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--fill);
  border-radius: 8px;
}
.map-member-name {
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 600;
}
.map-member-signature {
  color: var(--text-muted);
  font-size: var(--text-sm);
  word-break: break-all;
  white-space: pre-wrap;
}
.map-depends {
  flex-direction: row !important;
  flex-wrap: wrap;
}
.map-depend-link,
.map-depend-plain {
  padding: 3px 8px;
  border-radius: 6px;
  font-size: var(--text-sm);
}
.map-depend-link {
  color: var(--accent-strong);
  background: var(--accent-soft);
}
.map-depend-link:hover {
  filter: brightness(1.05);
  text-decoration: underline;
}
.map-depend-plain {
  display: inline-block;
  color: var(--text-muted);
  background: var(--fill);
}
.map-notes-list li {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.map-detail-source {
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
.map-source-link {
  color: var(--accent-strong);
  font-size: var(--text-sm);
  text-align: left;
}
.map-source-link:hover {
  text-decoration: underline;
}
</style>
