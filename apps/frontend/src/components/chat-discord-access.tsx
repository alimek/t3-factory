import { Eye, Plus, ShieldOff, Trash2 } from "lucide-react";
import type {
  DiscordSettings,
  FactoryProject,
  UpdateDiscordAccessInput,
} from "@t3-factory/contracts";
import { validateUpdateDiscordAccess } from "@t3-factory/domain-validation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fieldLabelClass } from "@/components/page";
import { api } from "../api.ts";
import { useProjects } from "../use-projects.ts";
import { Notice } from "./notice.tsx";
import { SectionSaveBar, useChatControlSection } from "./chat-control-form.tsx";

interface ChannelDraft {
  /** Stable while the owner edits the row's channel ID. */
  readonly key: number;
  readonly channelId: string;
  readonly projectIds: readonly string[];
}

export interface AccessDraft {
  /** One user ID per line, as typed. */
  readonly users: string;
  readonly channels: readonly ChannelDraft[];
}

let rowKeys = 0;

const draftOf = ({ access }: DiscordSettings): AccessDraft => ({
  users: access.users.join("\n"),
  channels: access.channels.map((channel) => ({ ...channel, key: rowKeys++ })),
});

const saveInput = (draft: AccessDraft, settings: DiscordSettings): UpdateDiscordAccessInput => ({
  revision: settings.access.revision,
  users: draft.users
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
  channels: draft.channels.map(({ channelId, projectIds }) => ({
    channelId: channelId.trim(),
    projectIds,
  })),
});

const sameAccess = (
  input: Pick<UpdateDiscordAccessInput, "users" | "channels">,
  saved: DiscordSettings["access"],
) =>
  JSON.stringify([input.users, input.channels]) === JSON.stringify([saved.users, saved.channels]);

/** Whether the host already holds exactly this save, so a lost acknowledgement was a success. */
const committed = (input: UpdateDiscordAccessInput, current: DiscordSettings) =>
  current.access.revision === input.revision + 1 && sameAccess(input, current.access);

/** The Access section's saved state and draft, independent of the connection section. */
export function useAccessSection() {
  const section = useChatControlSection({
    read: api.getDiscordSettings,
    update: api.updateDiscordAccess,
    draftOf,
    committed,
    name: "Access",
  });
  const { settings, draft } = section;
  return {
    ...section,
    dirty:
      settings !== null &&
      draft !== null &&
      !sameAccess(saveInput(draft, settings), settings.access),
  };
}

/** Where a draft breaks the Access rules, if anywhere; repeated IDs are refused, not merged. */
function draftProblem(input: UpdateDiscordAccessInput) {
  const validated = validateUpdateDiscordAccess(input);
  return validated.ok ? "" : validated.error.message;
}

/**
 * Who may invoke Chat control and where. Saved on its own, so revoking access never waits for
 * unsaved connection or model edits; a save is in effect when it returns.
 */
export function AccessForm({
  settings,
  draft,
  dirty,
  saving,
  saveError,
  onChange,
  onSave,
  onDiscard,
}: {
  settings: DiscordSettings;
  draft: AccessDraft;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  onChange: (draft: AccessDraft) => void;
  onSave: (input: UpdateDiscordAccessInput) => void;
  onDiscard: () => void;
}) {
  const projects = useProjects();
  const input = saveInput(draft, settings);
  const problem = draftProblem(input);
  const empty =
    input.users.length === 0 || !input.channels.some((channel) => channel.projectIds.length > 0);
  const setChannel = (key: number, change: Partial<ChannelDraft>) =>
    onChange({
      ...draft,
      channels: draft.channels.map((channel) =>
        channel.key === key ? { ...channel, ...change } : channel,
      ),
    });
  return (
    <section aria-label="Access" className="grid gap-4 border-t pt-5">
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-foreground">Access</h3>
        <p className="text-sm text-muted-foreground">
          Chat control answers only an allowed user who mentions the bot or replies to it in an
          allowed channel, or in a thread of one, about the Projects that channel grants. Server
          membership, roles and administrator status grant nothing.
        </p>
      </div>
      {!dirty && empty && (
        <Notice tone="neutral" icon={ShieldOff} title="Nobody can use Chat control yet">
          Allow at least one user and one channel that grants a Project. A channel without Projects
          grants nothing.
        </Notice>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="discord-access-users" className={fieldLabelClass}>
          Allowed user IDs
        </Label>
        <Textarea
          id="discord-access-users"
          value={draft.users}
          placeholder="One Discord user ID per line"
          spellCheck={false}
          disabled={saving}
          aria-describedby="discord-access-users-hint"
          onChange={(event) => onChange({ ...draft, users: event.target.value })}
        />
        <p id="discord-access-users-hint" className="text-sm text-muted-foreground">
          In Discord, turn on Developer Mode and choose Copy User ID. Names are not used.
        </p>
      </div>
      <div className="grid gap-3">
        <p className={fieldLabelClass}>Allowed channels</p>
        {draft.channels.length === 0 && (
          <p className="text-sm text-muted-foreground">No channel is allowed.</p>
        )}
        {draft.channels.map((channel, index) => (
          <ChannelRow
            key={channel.key}
            index={index}
            channel={channel}
            projects={projects}
            unresolved={settings.access.unresolvedProjectIds}
            disabled={saving}
            onChange={(change) => setChannel(channel.key, change)}
            onRemove={() =>
              onChange({
                ...draft,
                channels: draft.channels.filter((row) => row.key !== channel.key),
              })
            }
          />
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() =>
              onChange({
                ...draft,
                channels: [...draft.channels, { key: rowKeys++, channelId: "", projectIds: [] }],
              })
            }
          >
            <Plus aria-hidden strokeWidth={1.5} />
            Add channel
          </Button>
        </div>
      </div>
      <Notice
        tone="neutral"
        icon={Eye}
        title="Everyone who can read a channel sees the bot's posts"
      >
        Replies, reviews and reports in an allowed channel or its threads are visible to every
        Discord member who can read it, also people not allowed here. Match each channel's
        visibility to its Projects. Access does not change Discord permissions and gives no one
        access to Factory itself; approving a Factory client grants no Chat control access.
      </Notice>
      {dirty && problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      <SectionSaveBar
        saved={settings.access}
        dirty={dirty}
        saving={saving}
        onSave={dirty && !problem ? () => onSave(input) : undefined}
        onDiscard={onDiscard}
      />
    </section>
  );
}

function ChannelRow({
  index,
  channel,
  projects,
  unresolved,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  channel: ChannelDraft;
  projects: readonly FactoryProject[] | undefined;
  unresolved: readonly string[];
  disabled: boolean;
  onChange: (change: Partial<ChannelDraft>) => void;
  onRemove: () => void;
}) {
  const id = `discord-access-channel-${channel.key}`;
  const choices = [
    ...(projects ?? []).map((project) => ({
      id: project.id,
      label: project.title,
      detail: project.workspaceRoot,
    })),
    // A granted Project Factory no longer knows stays visible, grants nothing and can be removed.
    ...channel.projectIds
      .filter((projectId) => unresolved.includes(projectId))
      .map((projectId) => ({
        id: projectId,
        label: "Unknown Project",
        detail: `${projectId} · grants nothing`,
      })),
  ];
  const toggle = (projectId: string, granted: boolean) =>
    onChange({
      projectIds: granted
        ? [...channel.projectIds, projectId]
        : channel.projectIds.filter((granted) => granted !== projectId),
    });
  return (
    <div
      role="group"
      aria-label={`Allowed channel ${index + 1}`}
      className="grid gap-3 rounded-md border p-3"
    >
      <div className="flex items-end gap-2">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor={id} className={fieldLabelClass}>
            Channel ID
          </Label>
          <Input
            id={id}
            value={channel.channelId}
            placeholder="Copy Channel ID in Discord"
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            disabled={disabled}
            onChange={(event) => onChange({ channelId: event.target.value })}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove allowed channel ${index + 1}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden strokeWidth={1.5} />
        </Button>
      </div>
      <fieldset className="grid gap-2">
        <legend className={`${fieldLabelClass} pb-1`}>Projects this channel grants</legend>
        {projects === undefined && choices.length === 0 && (
          <p className="text-sm text-muted-foreground">Reading Factory's Projects…</p>
        )}
        {projects !== undefined && choices.length === 0 && (
          <p className="text-sm text-muted-foreground">Factory has no Projects to grant yet.</p>
        )}
        {choices.map((choice) => (
          <div key={choice.id} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={`${id}-${choice.id}`}
              className="mt-0.5"
              aria-describedby={`${id}-${choice.id}-detail`}
              checked={channel.projectIds.includes(choice.id)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(choice.id, checked === true)}
            />
            <span className="grid">
              <Label htmlFor={`${id}-${choice.id}`} className="font-normal text-foreground">
                {choice.label}
              </Label>
              <span id={`${id}-${choice.id}-detail`} className="text-muted-foreground">
                {choice.detail}
              </span>
            </span>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
