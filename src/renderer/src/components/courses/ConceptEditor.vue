<script setup lang="ts">
// Edits a course pack's concept skeleton as a list: each concept's id, name,
// summary and dimension, and its prerequisites picked from the other
// concepts. The course form (CARM-36) mounts it on a user pack's draft;
// built-in packs are read-only and never reach it. `errors` are the main
// process's, keyed like `concepts[2].id`, and win over the checks here.
import { computed } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { COURSE_DIMENSIONS } from '@shared/course_pack.ts';
import { MAX_CONCEPTS, conceptErrors, dimensionLabel } from '@/lib/course_model.ts';
import type { Concept } from '@shared/course_pack.ts';

const props = withDefaults(defineProps<{ errors?: Record<string, string> }>(), { errors: () => ({}) });
const concepts = defineModel<Concept[]>({ required: true });

const shown = computed(() => ({ ...conceptErrors(concepts.value), ...props.errors }));
const errorOf = (index: number, field: string) => shown.value[`concepts[${index}].${field}`];
const others = (index: number) => concepts.value.filter((_, at) => at !== index && concepts.value[at].id);

const newId = () => {
  const ids = new Set(concepts.value.map((item) => item.id));
  let number = concepts.value.length + 1;
  while (ids.has(`concept-${number}`)) number += 1;
  return `concept-${number}`;
};

const add = () => {
  concepts.value = [...concepts.value, { id: newId(), label: '', summary: '', prerequisites: [] }];
};

// Removing a concept also removes it from the others' prerequisites.
const remove = (index: number) => {
  const id = concepts.value[index].id;
  concepts.value = concepts.value
    .filter((_, at) => at !== index)
    .map((item) => (item.prerequisites.includes(id) ? { ...item, prerequisites: item.prerequisites.filter((other) => other !== id) } : item));
};

// Renaming an id carries the prerequisites that named it along.
const rename = (index: number, id: string) => {
  const old = concepts.value[index].id;
  concepts.value = concepts.value.map((item, at) =>
    at === index ? { ...item, id } : { ...item, prerequisites: item.prerequisites.map((other) => (other === old ? id : other)) },
  );
};

const patch = (index: number, change: Partial<Concept>) => {
  concepts.value = concepts.value.map((item, at) => (at === index ? { ...item, ...change } : item));
};

// "" is the 不指定 option; the pack leaves the field out.
const setDimension = (index: number, value: string) => {
  const { dimension: _dimension, ...rest } = concepts.value[index];
  concepts.value = concepts.value.map((item, at) => (at === index ? (value ? { ...rest, dimension: value as Concept['dimension'] } : rest) : item));
};
</script>

<template>
  <section class="concept-editor" aria-label="知识点">
    <p v-if="shown.concepts" class="field-error" role="alert" data-error="concepts">{{ shown.concepts }}</p>
    <ol class="concept-list">
      <li v-for="(item, index) in concepts" :key="index" class="concept-row" :data-concept-row="index">
        <div class="concept-head">
          <el-input
            :model-value="item.id"
            class="concept-id"
            aria-label="知识点 id"
            placeholder="id，如 round-robin"
            @update:model-value="(value: string) => rename(index, value)"
          />
          <el-input
            :model-value="item.label"
            aria-label="知识点名称"
            placeholder="名称"
            @update:model-value="(value: string) => patch(index, { label: value })"
          />
          <el-select
            :model-value="item.dimension ?? ''"
            class="concept-dimension"
            aria-label="通用维度"
            @update:model-value="(value: string) => setDimension(index, value)"
          >
            <el-option value="" label="不指定维度" />
            <el-option v-for="dimension in COURSE_DIMENSIONS" :key="dimension" :value="dimension" :label="dimensionLabel(dimension)" />
          </el-select>
          <button class="icon-button small" type="button" aria-label="删除知识点" data-action="remove-concept" @click="remove(index)">
            <AppIcon name="x" />
          </button>
        </div>
        <p v-if="errorOf(index, 'id')" class="field-error" :data-error="`concepts[${index}].id`">{{ errorOf(index, 'id') }}</p>
        <p v-if="errorOf(index, 'label')" class="field-error" :data-error="`concepts[${index}].label`">{{ errorOf(index, 'label') }}</p>
        <el-input
          :model-value="item.summary"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          aria-label="知识点说明"
          placeholder="说明：这个知识点是什么，学生要能说清什么"
          @update:model-value="(value: string) => patch(index, { summary: value })"
        />
        <p v-if="errorOf(index, 'summary')" class="field-error" :data-error="`concepts[${index}].summary`">{{ errorOf(index, 'summary') }}</p>
        <el-select
          :model-value="item.prerequisites"
          multiple
          filterable
          :multiple-limit="8"
          aria-label="前置知识点"
          placeholder="前置知识点：从本包的知识点里选"
          @update:model-value="(value: string[]) => patch(index, { prerequisites: value })"
        >
          <el-option v-for="other in others(index)" :key="other.id" :value="other.id" :label="other.label ? `${other.label}（${other.id}）` : other.id" />
        </el-select>
        <p v-if="errorOf(index, 'prerequisites')" class="field-error" :data-error="`concepts[${index}].prerequisites`">
          {{ errorOf(index, 'prerequisites') }}
        </p>
      </li>
    </ol>
    <button class="secondary-button small" type="button" data-action="add-concept" :disabled="concepts.length >= MAX_CONCEPTS" @click="add">
      <AppIcon name="plus" />
      添加知识点
    </button>
  </section>
</template>

<style scoped>
.concept-editor {
  display: grid;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.concept-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.concept-row {
  display: grid;
  gap: 6px;
  padding: var(--space-2);
  border: 1px solid var(--line-soft);
  border-radius: 10px;
}
.concept-head {
  display: grid;
  grid-template-columns: 180px 1fr 140px auto;
  gap: 6px;
  align-items: center;
}
.field-error {
  margin: 0;
  color: var(--danger);
}
</style>
