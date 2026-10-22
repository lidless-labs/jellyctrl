// Minimal type shapes for Jellyfin API responses. These cover the fields this
// MCP actually reads - not the full API surface. Anything else is passed
// through as `unknown` and re-serialized back to the caller.

export interface SystemInfo {
  ServerName: string;
  Version: string;
  Id: string;
  OperatingSystemDisplayName?: string;
  SystemArchitecture?: string;
  LocalAddress?: string;
  HasPendingRestart?: boolean;
  HasUpdateAvailable?: boolean;
  [key: string]: unknown;
}

export interface Library {
  Name: string;
  Locations: string[];
  CollectionType?: string;
  ItemId: string;
  [key: string]: unknown;
}

export interface UserPolicy {
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
  IsHidden?: boolean;
  EnableRemoteAccess?: boolean;
  EnableMediaPlayback?: boolean;
  EnableContentDeletion?: boolean;
  EnableContentDownloading?: boolean;
  EnableRemoteControlOfOtherUsers?: boolean;
  EnablePublicSharing?: boolean;
  EnableAllFolders?: boolean;
  EnabledFolders?: string[] | null;
  LoginAttemptsBeforeLockout?: number;
  InvalidLoginAttemptCount?: number;
  MaxActiveSessions?: number;
  AuthenticationProviderId?: string;
  [key: string]: unknown;
}

export interface User {
  Id?: string;
  Name?: string | null;
  HasPassword?: boolean | null;
  LastLoginDate?: string | null;
  LastActivityDate?: string | null;
  Policy?: UserPolicy | null;
  [key: string]: unknown;
}

export interface PlayState {
  PositionTicks?: number;
  IsPaused?: boolean;
  IsMuted?: boolean;
  VolumeLevel?: number;
  PlayMethod?: string;
  [key: string]: unknown;
}

export interface NowPlayingItem {
  Id: string;
  Name: string;
  Type: string;
  MediaType?: string;
  SeriesName?: string;
  SeriesId?: string;
  RunTimeTicks?: number;
  ProductionYear?: number;
  [key: string]: unknown;
}

export interface Session {
  Id: string;
  UserId?: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  DeviceId?: string;
  ApplicationVersion?: string;
  RemoteEndPoint?: string;
  NowPlayingItem?: NowPlayingItem;
  PlayState?: PlayState;
  [key: string]: unknown;
}

export interface Item {
  Id: string;
  Name: string;
  Type: string;
  MediaType?: string;
  SeriesName?: string;
  SeriesId?: string;
  ProductionYear?: number;
  DateCreated?: string;
  RunTimeTicks?: number;
  // Episode-specific: season (ParentIndexNumber) and episode (IndexNumber).
  ParentIndexNumber?: number;
  IndexNumber?: number;
  CommunityRating?: number;
  UserData?: UserItemData;
  [key: string]: unknown;
}

export interface ItemsResponse {
  Items: Item[];
  TotalRecordCount: number;
  StartIndex?: number;
}

export interface ActivityLogEntry {
  Id: number;
  Name: string;
  Type: string;
  Date: string;
  Severity: string;
  UserId?: string;
  ShortOverview?: string;
  Overview?: string;
  [key: string]: unknown;
}

export interface ActivityLogResponse {
  Items: ActivityLogEntry[];
  TotalRecordCount: number;
}

export interface ScheduledTask {
  Id: string;
  Name: string;
  Description?: string;
  Category?: string;
  State: string;
  CurrentProgressPercentage?: number;
  LastExecutionResult?: {
    StartTimeUtc?: string;
    EndTimeUtc?: string;
    Status?: string;
    ErrorMessage?: string;
  };
  [key: string]: unknown;
}

export interface Playlist {
  Id: string;
  Name: string;
  ChildCount?: number;
  MediaType?: string;
  [key: string]: unknown;
}

export interface UserItemData {
  ItemId?: string;
  PlaybackPositionTicks?: number;
  PlayedPercentage?: number;
  PlayCount?: number;
  IsFavorite?: boolean;
  Played?: boolean;
  LastPlayedDate?: string;
  Rating?: number;
  Likes?: boolean;
  Key?: string;
  [key: string]: unknown;
}

// Jellyfin playCommand values for POST /Sessions/{id}/Playing
export type PlayCommand = "PlayNow" | "PlayNext" | "PlayLast";

// Jellyfin general-command names used by POST /Sessions/{id}/Command
// Volume goes 0-100 as a string in Arguments.Volume.
export type GeneralCommand =
  | "SetVolume"
  | "Mute"
  | "Unmute"
  | "ToggleMute"
  | "DisplayMessage";

// Item types exposed by item-tool schemas for explicit filtering. Keep the
// list centralized so their enums and descriptions stay in sync.
export const VALID_ITEM_TYPES = [
  "Movie",
  "Series",
  "Episode",
  "Season",
  "Audio",
  "MusicAlbum",
  "MusicArtist",
  "Book",
  "Photo",
] as const;
