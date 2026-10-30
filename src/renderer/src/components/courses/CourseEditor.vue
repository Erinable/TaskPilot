<script setup lang="ts">
// The pack editor: every field of an imported or copied pack as a form.
// Errors use the main process's rules (@shared/course_rules.ts) and show
// under their field once the form is saved; the main process checks again
// and a field it refuses is shown the same way. The rubric's dimension is
// picked, never typed. Saving changes the content, so the pack is pending
// until this machine confirms it again; the form says so before saving.
// `save` replaces saving over the pack's file, for a drafted pack that has
// none yet (the requirement center's course interview).
import { computed, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import { FIELD_LABELS, GUIDE_FIELDS, draftOf, fieldErrorText, packOf } from '@/lib/course_model.ts';
import { useCoursesStore } from '@/stores/courses.ts';
import ConceptEditor from './ConceptEditor.vue';
import { COURSE_DIMENSIONS, COURSE_DIMENSION_LABELS } from '@shared/course_pack.ts';
import { LAB_TOOLCHAINS, TOOLCHAIN_LABELS } from '@shared/lab_toolchains.ts';
import { COURSE_LIMITS, checkCourse } from '@shared/course_rules.ts';
import type { CoursePack } from '@shared/course_pack.ts';

const props = defineProps<{ pack: CoursePack; save?: (pack: CoursePack) => Promise<{ field: string; message: string } | null> }>();
const emit = defineEmits<{ close: [] }>();

const courses = useCoursesStore();

const draft = ref(draftOf(props.pack));
// Errors show once saving was tried, then follow the edits.
const tried = ref(false);
// The concept list is mounted only when opened: os has dozens of concepts,
// each with a select of the others, and rendering them all slows every edit.
const conceptsOpen = ref(false);
// A field the main process refused, until the next edit of the form.
const serverError = ref<{ field: string; message: string } | null>(null);

const checked = computed(() => checkCourse(packOf(draft.value)));
const errors = computed(() => {
  const found = new Map<string, string>();
  if (!tried.value) return found;
  for (const error of checked.value.errors) if (!found.has(error.field)) found.set(error.field, fieldErrorText(error));
  if (serverError.value && !found.has(serverError.value.field)) found.set(serverError.value.field, serverError.value.message);
  return found;
});
// The concept editor shows its own checks; these are the ones it cannot make.
const conceptFieldErrors = computed(() => Object.fromEntries([...errors.value].filter(([field]) => field.startsWith('concepts'))));
const errorOf = (field: string) => errors.value.get(field) ?? null;
const invalid = (field: string) => errors.value.has(field);
const errorId = (field: string) => `course-error-${field.replace(/[^a-zA-Z0-9]/g, '-')}`;
const describedBy = (field: string) => (errors.value.has(field) ? errorId(field) : undefined);
// Errors on fields the form has no input for (the pack's size, a TOML line).
const otherErrors = computed(() => [...errors.value].filter(([field]) => field === 'pack' || field === 'toml' || field === 'schemaVersion'));

const edited = () => {
  serverError.value = null;
};

const TEXT_FIELDS = [
  { key: 'title', multiline: false },
  { key: 'version', multiline: false },
  { key: 'domain', multiline: false },
  { key: 'summary', multiline: true },
  { key: 'learner', multiline: true },
] as const;

// The repository's languages and some common ones to click; others can be typed.
const COMMON_LANGUAGES = ['typescript', 'python', 'rust', 'c', 'go', 'java'];
const languageOptions = computed(() => [...new Set([...(courses.list?.languages ?? []), ...COMMON_LANGUAGES, ...draft.value.languages])]);

const DIMENSION_OPTIONS = COURSE_DIMENSIONS.map((dimension) => ({ value: dimension, label: COURSE_DIMENSION_LABELS[dimension] }));

const addLine = (guide: (typeof GUIDE_FIELDS)[number]) => {
  draft.value[guide].push('');
  edited();
};
const removeLine = (guide: (typeof GUIDE_FIELDS)[number], index: number) => {
  draft.value[guide].splice(index, 1);
  edited();
};

const addItem = () => {
  draft.value.rubric.push({ id: `item${draft.value.rubric.length + 1}`, label: '', description: '', dimension: 'thinking', examples: [] });
  edited();
};
const removeItem = (index: number) => {
  draft.value.rubric.splice(index, 1);
  edited();
};
const moveItem = (index: number, offset: number) => {
  const [item] = draft.value.rubric.splice(index, 1);
  draft.value.rubric.splice(index + offset, 0, item);
  edited();
};
const addExample = (index: number) => {
  draft.value.rubric[index].examples.push({ observation: '', betterWay: '' });
  edited();
};
const removeExample = (index: number, exampleIndex: number) => {
  draft.value.rubric[index].examples.splice(exampleIndex, 1);
  edited();
};

const save = async () => {
  tried.value = true;
  serverError.value = null;
  if (!checked.value.pack) return;
  const refused = await (props.save ?? courses.save)(checked.value.pack);
  if (refused) serverError.value = refused;
  else emit('close');
};
</script>

<template>
  <form class="course-editor" novalidate aria-label="编辑课程包" @submit.prevent="save().catch((error) => console.error(error))" @input="edited">
    <p class="course-editor-note" role="note">
      <AppIcon name="info" />
      <span>保存后内容就变了：要在本机重新确认，确认之前规划和判卷不会用这个课程包。</span>
    </p>

    <div class="course-editor-field">
      <span class="course-editor-label">id</span>
      <code class="path-chip">{{ draft.id }}</code>
      <small>id 是文件名，不能改。想换 id 就复制一份。</small>
    </div>

    <label v-for="field in TEXT_FIELDS" :key="field.key" class="course-editor-field" :data-field="field.key">
      <span class="course-editor-label">{{ FIELD_LABELS[field.key] }}</span>
      <textarea
        v-if="field.multiline"
        v-model="draft[field.key]"
        class="field-input"
        rows="2"
        :aria-invalid="invalid(field.key)"
        :aria-describedby="describedBy(field.key)"
      ></textarea>
      <input v-else v-model="draft[field.key]" class="field-input" type="text" :aria-invalid="invalid(field.key)" :aria-describedby="describedBy(field.key)" />
      <small v-if="errorOf(field.key)" :id="errorId(field.key)" class="course-field-error" role="alert">{{ errorOf(field.key) }}</small>
    </label>

    <div class="course-editor-field" data-field="appliesTo">
      <span class="course-editor-label">{{ FIELD_LABELS.appliesTo }}</span>
      <el-select
        v-model="draft.languages"
        multiple
        filterable
        allow-create
        default-first-option
        :reserve-keyword="false"
        placeholder="不限"
        aria-label="适用语言"
        @change="edited"
      >
        <el-option v-for="language in languageOptions" :key="language" :label="language" :value="language" />
      </el-select>
      <div class="course-editor-toolchains">
        <span>工具链：</span>
        <el-checkbox-group v-model="draft.toolchains" aria-label="适用工具链" @change="edited">
          <el-checkbox v-for="toolchain in LAB_TOOLCHAINS" :key="toolchain" :value="toolchain">{{ TOOLCHAIN_LABELS[toolchain] }}</el-checkbox>
        </el-checkbox-group>
        <small v-if="!draft.toolchains.length">不限</small>
      </div>
      <template v-for="(_, index) in draft.languages" :key="index">
        <small v-if="errorOf(`appliesTo.languages[${index}]`)" class="course-field-error" role="alert">
          {{ draft.languages[index] }}：{{ errorOf(`appliesTo.languages[${index}]`) }}
        </small>
      </template>
      <small v-if="errorOf('appliesTo.languages')" class="course-field-error" role="alert">{{ errorOf('appliesTo.languages') }}</small>
    </div>

    <fieldset v-for="guide in GUIDE_FIELDS" :key="guide" class="course-editor-group" :data-field="guide">
      <legend>{{ FIELD_LABELS[guide] }}</legend>
      <div v-for="(_, index) in draft[guide]" :key="index" class="course-editor-line" :data-field="`${guide}[${index}]`">
        <textarea
          v-model="draft[guide][index]"
          class="field-input"
          rows="2"
          :aria-label="`${FIELD_LABELS[guide]}第 ${index + 1} 行`"
          :aria-invalid="invalid(`${guide}[${index}]`)"
          :aria-describedby="describedBy(`${guide}[${index}]`)"
        ></textarea>
        <button class="icon-button small" type="button" :aria-label="`删除第 ${index + 1} 行`" @click="removeLine(guide, index)">
          <AppIcon name="trash" />
        </button>
        <small v-if="errorOf(`${guide}[${index}]`)" :id="errorId(`${guide}[${index}]`)" class="course-field-error" role="alert">
          {{ errorOf(`${guide}[${index}]`) }}
        </small>
      </div>
      <button v-if="draft[guide].length < COURSE_LIMITS.guideLines" class="link-button" type="button" data-action="add-line" @click="addLine(guide)">
        <AppIcon name="plus" />
        加一行
      </button>
      <small v-if="errorOf(guide)" class="course-field-error" role="alert">{{ errorOf(guide) }}</small>
    </fieldset>

    <label class="course-editor-field" data-field="referenceGuide">
      <span class="course-editor-label">{{ FIELD_LABELS.referenceGuide }}</span>
      <textarea
        v-model="draft.referenceGuide"
        class="field-input"
        rows="3"
        :aria-invalid="invalid('referenceGuide')"
        :aria-describedby="describedBy('referenceGuide')"
      ></textarea>
      <small v-if="errorOf('referenceGuide')" :id="errorId('referenceGuide')" class="course-field-error" role="alert">{{ errorOf('referenceGuide') }}</small>
    </label>

    <fieldset class="course-editor-group" data-field="rubric">
      <legend>判卷维度（{{ COURSE_LIMITS.minRubric }} 到 {{ COURSE_LIMITS.maxRubric }} 项）</legend>
      <div v-for="(item, index) in draft.rubric" :key="index" class="course-editor-item" :data-field="`rubric[${index}]`">
        <div class="course-editor-item-head">
          <strong>第 {{ index + 1 }} 项</strong>
          <button class="icon-button small" type="button" :aria-label="`上移第 ${index + 1} 项`" :disabled="index === 0" @click="moveItem(index, -1)">
            <AppIcon name="arrow-left" class="quarter-turn" />
          </button>
          <button
            class="icon-button small"
            type="button"
            :aria-label="`下移第 ${index + 1} 项`"
            :disabled="index === draft.rubric.length - 1"
            @click="moveItem(index, 1)"
          >
            <AppIcon name="arrow-right" class="quarter-turn" />
          </button>
          <button class="icon-button small" type="button" :aria-label="`删除第 ${index + 1} 项`" @click="removeItem(index)"><AppIcon name="trash" /></button>
        </div>
        <label v-for="key in ['id', 'label'] as const" :key="key" class="course-editor-field" :data-field="`rubric[${index}].${key}`">
          <span class="course-editor-label">{{ key === 'id' ? 'id' : FIELD_LABELS.label }}</span>
          <input
            v-model="item[key]"
            class="field-input"
            :class="{ mono: key === 'id' }"
            type="text"
            :aria-invalid="invalid(`rubric[${index}].${key}`)"
            :aria-describedby="describedBy(`rubric[${index}].${key}`)"
          />
          <small v-if="key === 'id'">笔记的分类记的是这个 id，改了以后旧笔记会对不上。</small>
          <small v-if="errorOf(`rubric[${index}].${key}`)" :id="errorId(`rubric[${index}].${key}`)" class="course-field-error" role="alert">
            {{ errorOf(`rubric[${index}].${key}`) }}
          </small>
        </label>
        <div class="course-editor-field" :data-field="`rubric[${index}].dimension`">
          <span class="course-editor-label">{{ FIELD_LABELS.dimension }}</span>
          <el-radio-group v-model="item.dimension" :aria-label="`第 ${index + 1} 项的通用维度`" @change="edited">
            <el-radio-button v-for="option in DIMENSION_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
          </el-radio-group>
          <small v-if="errorOf(`rubric[${index}].dimension`)" class="course-field-error" role="alert">{{ errorOf(`rubric[${index}].dimension`) }}</small>
        </div>
        <label class="course-editor-field" :data-field="`rubric[${index}].description`">
          <span class="course-editor-label">{{ FIELD_LABELS.description }}</span>
          <textarea
            v-model="item.description"
            class="field-input"
            rows="2"
            :aria-invalid="invalid(`rubric[${index}].description`)"
            :aria-describedby="describedBy(`rubric[${index}].description`)"
          ></textarea>
          <small v-if="errorOf(`rubric[${index}].description`)" :id="errorId(`rubric[${index}].description`)" class="course-field-error" role="alert">
            {{ errorOf(`rubric[${index}].description`) }}
          </small>
        </label>
        <div class="course-editor-field">
          <span class="course-editor-label">{{ FIELD_LABELS.examples }}（最多 {{ COURSE_LIMITS.examples }} 条）</span>
          <div v-for="(example, exampleIndex) in item.examples" :key="exampleIndex" class="course-editor-example">
            <label v-for="key in ['observation', 'betterWay'] as const" :key="key" :data-field="`rubric[${index}].examples[${exampleIndex}].${key}`">
              <span class="course-editor-label">{{ key === 'observation' ? '看到的写法' : '更好的写法' }}</span>
              <textarea
                v-model="example[key]"
                class="field-input"
                rows="2"
                :aria-invalid="invalid(`rubric[${index}].examples[${exampleIndex}].${key}`)"
                :aria-describedby="describedBy(`rubric[${index}].examples[${exampleIndex}].${key}`)"
              ></textarea>
              <small
                v-if="errorOf(`rubric[${index}].examples[${exampleIndex}].${key}`)"
                :id="errorId(`rubric[${index}].examples[${exampleIndex}].${key}`)"
                class="course-field-error"
                role="alert"
              >
                {{ errorOf(`rubric[${index}].examples[${exampleIndex}].${key}`) }}
              </small>
            </label>
            <button class="icon-button small" type="button" :aria-label="`删除示例 ${exampleIndex + 1}`" @click="removeExample(index, exampleIndex)">
              <AppIcon name="trash" />
            </button>
          </div>
          <button v-if="item.examples.length < COURSE_LIMITS.examples" class="link-button" type="button" @click="addExample(index)">
            <AppIcon name="plus" />
            加一条示例
          </button>
        </div>
      </div>
      <button v-if="draft.rubric.length < COURSE_LIMITS.maxRubric" class="link-button" type="button" data-action="add-rubric" @click="addItem">
        <AppIcon name="plus" />
        加一项判卷维度
      </button>
      <small v-if="errorOf('rubric')" class="course-field-error" role="alert">{{ errorOf('rubric') }}</small>
    </fieldset>

    <fieldset class="course-editor-group" data-field="concepts">
      <legend>知识点（可选，最多 {{ COURSE_LIMITS.concepts }} 个）</legend>
      <ConceptEditor v-if="conceptsOpen" v-model="draft.concepts" :errors="conceptFieldErrors" @update:model-value="edited" />
      <button v-else class="link-button" type="button" data-action="open-concepts" @click="conceptsOpen = true">
        <AppIcon name="sliders" />
        编辑知识点（{{ draft.concepts.length }} 个）
      </button>
      <small v-if="!conceptsOpen && conceptFieldErrors.concepts" class="course-field-error" role="alert">{{ conceptFieldErrors.concepts }}</small>
    </fieldset>

    <p v-for="[field, message] in otherErrors" :key="field" class="course-field-error" role="alert">{{ message }}</p>

    <div class="course-editor-actions">
      <button class="secondary-button" type="button" @click="emit('close')">取消</button>
      <button class="primary-button" type="submit" data-action="save-course" :disabled="courses.busy">
        <AppIcon name="check" />
        保存
      </button>
    </div>
  </form>
</template>

<style scoped>
.course-editor {
  display: grid;
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.course-editor-note {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warning);
  border-radius: 12px;
  color: var(--text-secondary);
}
.course-editor-note .icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  color: var(--warning);
}
.course-editor-field {
  display: grid;
  gap: 4px;
}
.course-editor-field small,
.course-editor-group small {
  color: var(--text-muted);
}
.course-editor-label,
.course-editor-group legend {
  color: var(--text-muted);
  font-weight: 600;
}
.course-editor-group {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-3);
  border: 1px solid var(--line-soft);
  border-radius: 12px;
}
.course-editor-line,
.course-editor-example {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px var(--space-2);
  align-items: start;
}
.course-editor-line > small,
.course-editor-example > label {
  grid-column: 1;
}
.course-editor-example > label {
  display: grid;
  gap: 4px;
}
.course-editor-example > button {
  grid-column: 2;
  grid-row: 1;
}
.course-editor-item {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--line-soft);
}
.course-editor-item-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.course-editor-item-head strong {
  flex: 1;
}
.quarter-turn {
  transform: rotate(90deg);
}
.course-editor-group > .link-button,
.course-editor-field > .link-button {
  justify-self: start;
}
.course-editor .course-field-error {
  color: var(--danger);
}
.course-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
