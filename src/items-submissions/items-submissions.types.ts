export type SubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface CurrentItemSnapshot {
  name: string | null;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
  type_name: string | null;
}

export interface ItemSubmission {
  id: number;
  item_id: number;
  submitter_steam: string;
  submitter_discord_name: string | null;
  name: string | null;
  description: string | null;
  image_url: string | null;
  type_id: number | null;
  status: SubmissionStatus;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewer_discord_name: string | null;
  reviewed_at: Date | null;
  submitted_at: Date;
  current_item: CurrentItemSnapshot | null;
}

export interface SubmissionPatch {
  name?: string | null;
  description?: string | null;
  image_url?: string | null;
  type_id?: number | null;
}
