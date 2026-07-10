/**
 * EmployeeInfoPage
 *
 * Workspace employee detail page. Employees are editable agent identities backed
 * by employees/{slug}/config.json, EMPLOYEE.md, and MEMORY.md.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { FolderOpen, MessageSquare, Plus, Save, Trash2, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import {
  Info_Page,
  Info_Section,
  Info_Table,
} from '@/components/info'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { InlineColorPickerRow } from '@/components/ui/inline-color-picker-row'
import { PROJECT_COLOR_PALETTE } from '@/utils/project-colors'
import { SkillSelectorPopover } from '@/components/ui/SkillSelectorPopover'
import { SourceSelectorPopover } from '@/components/ui/SourceSelectorPopover'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { cn } from '@/lib/utils'
import type { LoadedEmployee } from '@craft-agent/shared/employees/types'
import type { LoadedSkill, LoadedSource } from '../../shared/types'

interface EmployeeInfoPageProps {
  employeeSlug: string
}

type TabKey = 'sessions' | 'settings' | 'identity' | 'memory'

export default function EmployeeInfoPage({ employeeSlug }: EmployeeInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { onCreateSession, onOpenFile } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const skills = useAtomValue(skillsAtom)
  const sources = useAtomValue(sourcesAtom)

  const [employee, setEmployee] = useState<LoadedEmployee | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('settings')
  const [savingSettings, setSavingSettings] = useState(false)
  const [savingDefinition, setSavingDefinition] = useState(false)
  const [savingMemory, setSavingMemory] = useState(false)

  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editSkillSlugs, setEditSkillSlugs] = useState<string[]>([])
  const [editSourceSlugs, setEditSourceSlugs] = useState<string[]>([])
  const [editDefinition, setEditDefinition] = useState('')
  const [editMemory, setEditMemory] = useState('')

  const skillButtonRef = useRef<HTMLButtonElement | null>(null)
  const sourceButtonRef = useRef<HTMLButtonElement | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)

  const loadEmployee = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.getEmployee(workspaceId, employeeSlug)
      if (!result) {
        setEmployee(null)
        setError(t('employeeInfo.notFound', '员工不存在'))
        return
      }
      const loaded = result as LoadedEmployee
      setEmployee(loaded)
      setEditName(loaded.config.name)
      setEditDescription(loaded.config.description ?? '')
      setEditColor(loaded.config.color ?? '')
      setEditSkillSlugs(loaded.config.skillSlugs ?? [])
      setEditSourceSlugs(loaded.config.enabledSourceSlugs ?? [])
      setEditDefinition(loaded.definition ?? '')
      setEditMemory(loaded.memoryContent ?? '')
    } catch (err) {
      console.error('[EmployeeInfoPage] Failed to load employee:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, employeeSlug, t])

  useEffect(() => {
    loadEmployee()
  }, [loadEmployee])

  useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEmployeesChanged((wsId: string) => {
      if (wsId === workspaceId) loadEmployee()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, loadEmployee])

  const employeeSessions = useMemo(() => {
    if (!employee) return []
    const result: { id: string; name: string }[] = []
    for (const meta of sessionMetaMap.values()) {
      if ((meta as { employeeId?: string }).employeeId === employee.config.id) {
        result.push({ id: meta.id, name: meta.name ?? meta.id })
      }
    }
    return result
  }, [employee, sessionMetaMap])

  const selectedSkills = useMemo(
    () => editSkillSlugs
      .map(slug => skills.find(skill => skill.slug === slug))
      .filter((skill): skill is LoadedSkill => Boolean(skill)),
    [editSkillSlugs, skills],
  )

  const selectedSources = useMemo(
    () => editSourceSlugs
      .map(slug => sources.find(source => source.config.slug === slug))
      .filter((source): source is LoadedSource => Boolean(source)),
    [editSourceSlugs, sources],
  )

  const handleToggleSkill = useCallback((slug: string) => {
    setEditSkillSlugs(prev => prev.includes(slug) ? prev.filter(item => item !== slug) : [...prev, slug])
  }, [])

  const handleToggleSource = useCallback((slug: string) => {
    setEditSourceSlugs(prev => prev.includes(slug) ? prev.filter(item => item !== slug) : [...prev, slug])
  }, [])

  const handleSaveSettings = useCallback(async () => {
    if (!workspaceId || !employee) return
    setSavingSettings(true)
    try {
      await window.electronAPI.updateEmployee(workspaceId, employee.config.slug, {
        name: editName.trim() || employee.config.name,
        description: editDescription.trim() || undefined,
        color: editColor.trim() || undefined,
        skillSlugs: editSkillSlugs,
        enabledSourceSlugs: editSourceSlugs,
      })
      toast.success(t('employeeInfo.saved', '已保存员工设置'))
      await loadEmployee()
    } catch (err) {
      console.error('[EmployeeInfoPage] Save settings failed:', err)
      toast.error(t('employeeInfo.saveFailed', '保存失败'))
    } finally {
      setSavingSettings(false)
    }
  }, [workspaceId, employee, editName, editDescription, editColor, editSkillSlugs, editSourceSlugs, t, loadEmployee])

  const handleSaveDefinition = useCallback(async () => {
    if (!workspaceId || !employee) return
    setSavingDefinition(true)
    try {
      await window.electronAPI.updateEmployeeDefinition(workspaceId, employee.config.slug, editDefinition)
      toast.success(t('employeeInfo.identitySaved', '已保存身份定义'))
      await loadEmployee()
    } catch (err) {
      console.error('[EmployeeInfoPage] Save definition failed:', err)
      toast.error(t('employeeInfo.saveFailed', '保存失败'))
    } finally {
      setSavingDefinition(false)
    }
  }, [workspaceId, employee, editDefinition, t, loadEmployee])

  const handleSaveMemory = useCallback(async () => {
    if (!workspaceId || !employee) return
    setSavingMemory(true)
    try {
      await window.electronAPI.updateEmployeeMemory(workspaceId, employee.config.slug, editMemory)
      toast.success(t('employeeInfo.memorySaved', '已保存员工记忆'))
      await loadEmployee()
    } catch (err) {
      console.error('[EmployeeInfoPage] Save memory failed:', err)
      toast.error(t('employeeInfo.saveFailed', '保存失败'))
    } finally {
      setSavingMemory(false)
    }
  }, [workspaceId, employee, editMemory, t, loadEmployee])

  const handleStartSession = useCallback(async () => {
    if (!workspaceId || !employee) return
    try {
      const session = await onCreateSession(workspaceId, { employeeId: employee.config.id })
      if (session?.id) navigate(routes.view.allSessions(session.id))
    } catch (err) {
      console.error('[EmployeeInfoPage] Failed to create employee session:', err)
      toast.error(t('employeeInfo.newSessionFailed', '新建员工会话失败'))
    }
  }, [workspaceId, employee, onCreateSession, t])

  const handleShowSessions = useCallback(() => {
    if (!employee) return
    navigate(routes.view.allSessions())
    window.dispatchEvent(new CustomEvent('craft:employee-filter', { detail: { employeeId: employee.config.id } }))
  }, [employee])

  const handleDeleteEmployee = useCallback(async () => {
    if (!workspaceId || !employee) return
    if (!window.confirm(t('employeeInfo.deleteConfirm', `删除员工「${employee.config.name}」？相关会话会被解绑。`, { name: employee.config.name }))) return
    try {
      await window.electronAPI.deleteEmployee(workspaceId, employee.config.slug)
      toast.success(t('employeeInfo.deleted', '员工已删除'))
      navigate(routes.view.employees())
    } catch (err) {
      console.error('[EmployeeInfoPage] Delete failed:', err)
      toast.error(t('employeeInfo.deleteFailed', '删除失败'))
    }
  }, [workspaceId, employee, t])

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!employee && !loading && !error ? t('employeeInfo.notFound', '员工不存在') : undefined}
    >
      <Info_Page.Header title={employee?.config.name ?? ''} />
      {employee && (
        <Info_Page.Content>
          <Info_Page.Hero
            avatar={<UserRound className="h-6 w-6 text-foreground/60" />}
            title={employee.config.name}
            tagline={employee.config.description ?? t('employeeInfo.taglineFallback', '员工身份、默认上下文和长期工作记忆')}
          />

          <div className="flex items-center gap-1 border-b border-border/50 px-2 mb-4">
            <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
              {t('employeeInfo.tabSessions', '会话')}
            </TabButton>
            <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
              {t('employeeInfo.tabSettings', '设置')}
            </TabButton>
            <TabButton active={tab === 'identity'} onClick={() => setTab('identity')}>
              {t('employeeInfo.tabIdentity', '身份定义')}
            </TabButton>
            <TabButton active={tab === 'memory'} onClick={() => setTab('memory')}>
              {t('employeeInfo.tabMemory', '员工记忆')}
            </TabButton>
          </div>

          {tab === 'sessions' && (
            <Info_Section
              title={t('employeeInfo.tabSessions', '会话')}
              actions={
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={handleShowSessions}>
                    <MessageSquare className="h-3.5 w-3.5 mr-1" />
                    {t('employeeInfo.filterSessions', '筛选会话')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleStartSession}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    {t('employeeInfo.newSession', '新建会话')}
                  </Button>
                </div>
              }
            >
              {employeeSessions.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {t('employeeInfo.noSessions', '这个员工还没有绑定会话。')}
                </div>
              ) : (
                <ul className="divide-y divide-border/50">
                  {employeeSessions.map((session) => (
                    <li key={session.id} className="px-4 py-2">
                      <button
                        type="button"
                        className="text-sm text-foreground hover:underline text-left"
                        onClick={() => navigate(routes.view.allSessions(session.id))}
                      >
                        {session.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Info_Section>
          )}

          {tab === 'settings' && (
            <Info_Section title={t('employeeInfo.tabSettings', '设置')}>
              <div className="space-y-4 px-4 py-3">
                <Field label={t('employeeInfo.name', '名称')}>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                </Field>
                <Field label={t('employeeInfo.description', '描述')}>
                  <Input
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder={t('employeeInfo.descriptionPlaceholder', '这个员工负责什么')}
                  />
                </Field>
                <Field label={t('employeeInfo.color', '颜色')}>
                  <InlineColorPickerRow
                    value={editColor}
                    onChange={setEditColor}
                    presets={PROJECT_COLOR_PALETTE}
                    onClear={() => setEditColor('')}
                    clearLabel={t('employeeInfo.colorClear', '清除颜色')}
                    customAriaLabel={t('employeeInfo.colorCustom', '自定义颜色')}
                  />
                </Field>
                <Field
                  label={t('employeeInfo.defaultSkills', '默认技能')}
                  hint={t('employeeInfo.defaultSkillsHint', '绑定这个员工的会话发送消息时，会自动启用这些技能。')}
                >
                  <SelectorRow
                    buttonRef={skillButtonRef}
                    label={t('employeeInfo.addSkills', '添加技能')}
                    onOpen={() => setSkillsOpen(true)}
                  >
                    {selectedSkills.map((skill) => (
                      <SelectionChip
                        key={skill.slug}
                        icon={<SkillAvatar skill={skill} size="xs" workspaceId={workspaceId} />}
                        label={skill.metadata.name}
                        onRemove={() => handleToggleSkill(skill.slug)}
                      />
                    ))}
                  </SelectorRow>
                  <SkillSelectorPopover
                    open={skillsOpen}
                    onOpenChange={setSkillsOpen}
                    anchorRef={skillButtonRef}
                    skills={skills}
                    selectedSlugs={editSkillSlugs}
                    onToggleSlug={handleToggleSkill}
                    workspaceId={workspaceId}
                  />
                </Field>
                <Field
                  label={t('employeeInfo.defaultSources', '默认数据源')}
                  hint={t('employeeInfo.defaultSourcesHint', '绑定这个员工的会话发送消息时，会自动带上这些数据源。')}
                >
                  <SelectorRow
                    buttonRef={sourceButtonRef}
                    label={t('employeeInfo.addSources', '添加数据源')}
                    onOpen={() => setSourcesOpen(true)}
                  >
                    {selectedSources.map((source) => (
                      <SelectionChip
                        key={source.config.slug}
                        icon={<SourceAvatar source={source} size="xs" />}
                        label={source.config.name}
                        onRemove={() => handleToggleSource(source.config.slug)}
                      />
                    ))}
                  </SelectorRow>
                  <SourceSelectorPopover
                    open={sourcesOpen}
                    onOpenChange={setSourcesOpen}
                    anchorRef={sourceButtonRef}
                    sources={sources}
                    selectedSlugs={editSourceSlugs}
                    onToggleSlug={handleToggleSource}
                  />
                </Field>
                <div className="flex justify-between pt-2">
                  <Button
                    variant="ghost"
                    onClick={handleDeleteEmployee}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    {t('employeeInfo.deleteEmployee', '删除员工')}
                  </Button>
                  <Button onClick={handleSaveSettings} disabled={savingSettings}>
                    <Save className="h-3.5 w-3.5 mr-1" />
                    {savingSettings ? t('common.saving', '保存中') : t('common.save', '保存')}
                  </Button>
                </div>
              </div>
            </Info_Section>
          )}

          {tab === 'identity' && (
            <Info_Section
              title={t('employeeInfo.tabIdentity', '身份定义')}
              actions={
                <Button size="sm" onClick={handleSaveDefinition} disabled={savingDefinition}>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  {savingDefinition ? t('common.saving', '保存中') : t('common.save', '保存')}
                </Button>
              }
            >
              <div className="px-4 py-3">
                <Textarea
                  value={editDefinition}
                  onChange={(e) => setEditDefinition(e.target.value)}
                  rows={22}
                  className="font-mono text-xs leading-5"
                />
              </div>
            </Info_Section>
          )}

          {tab === 'memory' && (
            <Info_Section
              title={t('employeeInfo.tabMemory', '员工记忆')}
              actions={
                <Button size="sm" onClick={handleSaveMemory} disabled={savingMemory}>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  {savingMemory ? t('common.saving', '保存中') : t('common.save', '保存')}
                </Button>
              }
            >
              <div className="px-4 py-3">
                <Textarea
                  value={editMemory}
                  onChange={(e) => setEditMemory(e.target.value)}
                  rows={22}
                  className="font-mono text-xs leading-5"
                />
              </div>
            </Info_Section>
          )}

          <Info_Section title={t('employeeInfo.metadata', '元数据')}>
            <Info_Table>
              <Info_Table.Row label={t('common.id', 'ID')} value={employee.config.id} />
              <Info_Table.Row label={t('common.slug', 'Slug')} value={employee.config.slug} />
              <Info_Table.Row label={t('employeeInfo.definitionFile', '身份文件')} value={employee.definitionPath} />
              <Info_Table.Row label={t('employeeInfo.memoryFile', '记忆文件')} value={employee.memoryPath} />
              <Info_Table.Row label={t('common.location', '位置')}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex-1 min-w-0 truncate font-mono text-xs">{employee.folderPath}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onOpenFile(employee.folderPath)}
                        className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors"
                        aria-label={t('employeeInfo.openLocation', '打开位置')}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('employeeInfo.openLocation', '打开位置')}</TooltipContent>
                  </Tooltip>
                </div>
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm rounded-t-md border-b-2',
        active
          ? 'border-foreground/80 text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground/80',
      )}
    >
      {children}
    </button>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-foreground/70 mb-1">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-foreground/50">{hint}</div>}
    </label>
  )
}

function SelectorRow({
  buttonRef,
  label,
  onOpen,
  children,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  label: string
  onOpen: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-input bg-background px-2 py-2">
      {children}
      <button
        ref={buttonRef as React.Ref<HTMLButtonElement>}
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 h-7 px-2 text-xs font-medium rounded-[6px] bg-foreground/[0.04] hover:bg-foreground/[0.07] transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        {label}
      </button>
    </div>
  )
}

function SelectionChip({
  icon,
  label,
  onRemove,
}: {
  icon: React.ReactNode
  label: string
  onRemove: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5 h-7 rounded-[6px] bg-foreground/[0.04] px-2 text-xs">
      {icon}
      <span className="max-w-[180px] truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-foreground/10 text-foreground/60 hover:text-foreground"
        aria-label={`Remove ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
