<script setup lang="ts">
// Every field of a course pack, as the agents will be told it: the preview
// dialog and the 课程 view show this. Fields that changed since this
// machine confirmed the pack are marked. Text only: the pack is someone
// else's content.
import { computed } from 'vue';

import { FIELD_LABELS, GUIDE_FIELDS, changedFields, dimensionLabel, itemChanged } from '@/lib/course_model.ts';
import { TOOLCHAIN_LABELS } from '@shared/lab_toolchains.ts';
import type { CourseChange } from '@shared/course_changes.ts';
import type { CoursePack } from '@shared/course_pack.ts';

const props = defineProps<{ pack: CoursePack; changes: CourseChange[] }>();

const marked = computed(() => changedFields(props.changes));
const isMarked = (field: string) => marked.value.has(field);
const conceptLabels = computed(() => new Map((props.pack.concepts ?? []).map((item) => [item.id, item.label])));
// labGuide is optional: shown when the pack has it, or when it was removed.
const guides = computed(() => GUIDE_FIELDS.filter((name) => props.pack[name] || isMarked(name)));
const appliesToText = computed(() => {
  const languages = props.pack.appliesTo?.languages?.join(', ') ?? '不限';
  const toolchains = props.pack.appliesTo?.toolchains?.map((id) => TOOLCHAIN_LABELS[id]).join(', ') ?? '不限';
  return `语言：${languages}；工具链：${toolchains}`;
});
</script>

<template>
  <dl class="course-fields">
    <div :class="{ changed: isMarked('summary') }">
      <dt>{{ FIELD_LABELS.summary }}</dt>
      <dd>{{ pack.summary }}</dd>
    </div>
    <div :class="{ changed: isMarked('domain') }">
      <dt>{{ FIELD_LABELS.domain }}</dt>
      <dd>{{ pack.domain }}</dd>
    </div>
    <div :class="{ changed: isMarked('learner') }">
      <dt>{{ FIELD_LABELS.learner }}</dt>
      <dd>{{ pack.learner }}</dd>
    </div>
    <div v-if="pack.appliesTo?.languages || pack.appliesTo?.toolchains || isMarked('appliesTo')" :class="{ changed: isMarked('appliesTo') }">
      <dt>{{ FIELD_LABELS.appliesTo }}</dt>
      <dd>{{ appliesToText }}</dd>
    </div>
    <div v-for="guide in guides" :key="guide" :class="{ changed: isMarked(guide) }">
      <dt>{{ FIELD_LABELS[guide] }}</dt>
      <dd>
        <ul class="course-lines">
          <li v-for="(line, index) in pack[guide] ?? ['（无）']" :key="index">{{ line }}</li>
        </ul>
      </dd>
    </div>
    <div :class="{ changed: isMarked('referenceGuide') }">
      <dt>{{ FIELD_LABELS.referenceGuide }}</dt>
      <dd>{{ pack.referenceGuide }}</dd>
    </div>
    <div :class="{ changed: isMarked('rubric') }">
      <dt>判卷维度</dt>
      <dd>
        <ul class="course-rubric">
          <li v-for="item in pack.rubric" :key="item.id" :data-rubric="item.id" :class="{ changed: itemChanged(marked, 'rubric', item.id) }">
            <strong>{{ item.label }}</strong>
            <small>（{{ item.id }}，通用维度：{{ dimensionLabel(item.dimension) }}）</small>
            <p>{{ item.description }}</p>
            <ul v-if="item.examples" class="course-lines">
              <li v-for="(example, index) in item.examples" :key="index">{{ example.observation }} → {{ example.betterWay }}</li>
            </ul>
          </li>
        </ul>
      </dd>
    </div>
    <div v-if="pack.concepts || isMarked('concepts')" :class="{ changed: isMarked('concepts') }">
      <dt>知识点（{{ pack.concepts?.length ?? 0 }} 个）</dt>
      <dd>
        <ul class="course-rubric">
          <li v-for="item in pack.concepts" :key="item.id" :data-concept="item.id" :class="{ changed: itemChanged(marked, 'concepts', item.id) }">
            <strong>{{ item.label }}</strong>
            <small>
              （{{ item.id }}
              <template v-if="item.dimension">，通用维度：{{ dimensionLabel(item.dimension) }}</template>
              ）
            </small>
            <p>{{ item.summary }}</p>
            <p v-if="item.prerequisites.length" class="course-prerequisites">
              前置：{{ item.prerequisites.map((id) => conceptLabels.get(id) ?? id).join('、') }}
            </p>
          </li>
        </ul>
      </dd>
    </div>
  </dl>
</template>

<style>
/* Shared with the teleported preview dialog, so not scoped. */
.course-fields {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
}
.course-fields > div {
  padding: 6px 10px;
  border-left: 3px solid transparent;
  border-radius: 6px;
}
.course-fields .changed,
.course-rubric li.changed {
  border-left-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}
.course-fields dt {
  color: var(--text-muted);
  font-weight: 600;
}
.course-fields dd {
  margin: 2px 0 0;
  color: var(--text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.course-lines,
.course-rubric {
  margin: 0;
  padding-left: 1.2em;
}
.course-rubric {
  display: grid;
  gap: 6px;
  padding-left: 0;
  list-style: none;
}
.course-rubric > li {
  padding: 4px 8px;
  border-left: 3px solid transparent;
  border-radius: 6px;
}
.course-rubric p {
  margin: 2px 0 0;
}
.course-prerequisites {
  color: var(--text-muted);
}
</style>
