<script setup lang="ts">
import { computed } from 'vue';

import type { CoursePack, CourseRef } from '@shared/course_pack.ts';

const props = defineProps<{ pack: CoursePack; source: CourseRef['source'] }>();
const concepts = computed(() => props.pack.concepts ?? []);
// These translations describe the shipped versions in the overview only.
// Trust confirmation and agent instructions always retain the pack's original text.
const BUILTIN_OVERVIEWS: Record<string, { learner: string; rubric: Record<string, string> }> = {
  'programming@1.0.0': {
    learner: '刚开始学习编程的开发者。',
    rubric: {
      thinking: '如何拆解问题，处理或遗漏了哪些情况，以及逻辑放在哪里。',
      writing: '如何运用语言特性和库，处理错误并编写测试。',
      style: '命名、代码布局，以及是否遵循项目现有的约定。',
    },
  },
  'os@0.2.0': {
    learner: '已掌握基础 C 语言、正在学习操作系统的学生。',
    rubric: {
      concept: '是否正确理解机制：哪些操作在用户态或内核态执行，需要保存哪些状态，以及应保持哪些条件。',
      mechanism: '如何实现内核代码：加锁、处理错误、释放已分配的资源，以及表已满或分配失败等边界情况。',
      safety: '是否处理好竞争条件、锁的顺序、持锁期间的中断，以及用户输入的可信边界。',
    },
  },
};
const overviewText = computed(() => (props.source === 'builtin' ? BUILTIN_OVERVIEWS[`${props.pack.id}@${props.pack.version}`] : undefined));
const learner = computed(() => overviewText.value?.learner ?? props.pack.learner);
const rubric = computed(() => props.pack.rubric.map((item) => ({ ...item, description: overviewText.value?.rubric[item.id] ?? item.description })));
</script>

<template>
  <section class="course-overview" aria-label="课程概览" data-section="course-overview">
    <section aria-label="课程简介">
      <h3>课程简介</h3>
      <p>{{ pack.summary }}</p>
    </section>
    <section aria-label="适合谁">
      <h3>适合谁</h3>
      <p>{{ learner }}</p>
    </section>
    <section aria-label="练习内容">
      <h3>练习内容</h3>
      <template v-if="concepts.length">
        <p class="course-overview-note">课程包包含 {{ concepts.length }} 个知识点，以下是前 {{ Math.min(4, concepts.length) }} 个：</p>
        <ul class="course-overview-concepts">
          <li v-for="concept in concepts.slice(0, 4)" :key="concept.id">
            <strong>{{ concept.label }}</strong>
            <p>{{ concept.summary }}</p>
          </li>
        </ul>
        <p v-if="concepts.length > 4" class="course-overview-note">其余知识点及前置关系可在下方「完整课程指令」中查看。</p>
      </template>
      <p v-else>课程包未列出固定知识点。课程简介说明了练习方向，具体任务以需求规划为准。</p>
    </section>
    <section aria-label="如何判卷">
      <h3>如何判卷</h3>
      <p class="course-overview-note">导师按课程包中的以下维度给出反馈：</p>
      <dl class="course-overview-rubric">
        <div v-for="item in rubric" :key="item.id">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.description }}</dd>
        </div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
.course-overview {
  display: grid;
  gap: var(--space-5);
  color: var(--text);
  font-size: var(--text-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.course-overview section {
  min-width: 0;
}
.course-overview h3 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-lg);
}
.course-overview p {
  margin: 0;
  white-space: pre-wrap;
}
.course-overview .course-overview-note {
  color: var(--text-secondary);
}
.course-overview-concepts {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding-inline-start: var(--space-5);
}
.course-overview-concepts p {
  color: var(--text-secondary);
}
.course-overview-rubric {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
}
.course-overview-rubric dt {
  font-weight: 600;
}
.course-overview-rubric dd {
  margin: 0;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
</style>
