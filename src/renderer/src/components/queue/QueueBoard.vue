<script setup lang="ts">
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import BoardCard from './BoardCard.vue';
import { COLUMNS, groupByColumn, inProgressCount } from '@/lib/board.ts';
import type * as ipc from '@shared/ipc_types.ts';

// One column per stage. On a narrow window the columns stack and read as a
// list grouped by stage; nothing scrolls sideways.
const props = defineProps<{ tasks: ipc.TaskView[] }>();
const columns = computed(() => groupByColumn(props.tasks));
const busy = computed(() => inProgressCount(props.tasks));
</script>

<template>
  <div class="board" role="list" aria-label="工作包看板">
    <section v-for="column in COLUMNS" :key="column.id" class="board-column" role="listitem" :aria-labelledby="`board-${column.id}`">
      <header class="board-column-head">
        <h3 :id="`board-${column.id}`">{{ column.label }}</h3>
        <span class="board-count" :aria-label="`${columns[column.id].length} 个`">{{ columns[column.id].length }}</span>
      </header>
      <p v-if="column.id === 'doing' && busy > 1" class="board-hint" role="status">
        <AppIcon name="info" />
        同时在做 {{ busy }} 个。建议一次只做 1 个，改动不容易混在一起。
      </p>
      <div class="board-cards">
        <BoardCard v-for="task in columns[column.id]" :key="task.id" :task="task" />
        <p v-if="!columns[column.id].length" class="board-empty">{{ column.hint }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.board {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-3);
  padding: 0 var(--panel-pad) var(--panel-pad);
}
.board-column {
  display: grid;
  grid-template-rows: auto auto 1fr;
  align-content: start;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  background: var(--fill);
}
.board-column-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) var(--space-1) 0;
}
.board-column-head h3 {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 600;
}
.board-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 10px;
  color: var(--text-tertiary);
  background: var(--fill);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.board-hint {
  display: flex;
  gap: var(--space-1);
  align-items: flex-start;
  margin: 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--warning);
  background: var(--warning-soft);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.board-hint .icon {
  width: 13px;
  height: 13px;
  flex: none;
  margin-top: 2px;
}
.board-cards {
  display: grid;
  align-content: start;
  gap: var(--space-2);
}
.board-empty {
  margin: 0;
  padding: var(--space-3) var(--space-1);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  text-align: center;
}
@media (max-width: 1100px) {
  .board {
    grid-template-columns: 1fr;
  }
  .board-cards {
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
  .board-empty {
    text-align: left;
  }
}
</style>
