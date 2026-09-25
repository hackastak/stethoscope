CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`github_id` integer NOT NULL,
	`number` integer NOT NULL,
	`author_id` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`merged_at` integer,
	`closed_at` integer,
	`additions` integer NOT NULL,
	`deletions` integer NOT NULL,
	`changed_files` integer NOT NULL,
	`last_commit_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pull_requests_state_check" CHECK("pull_requests"."state" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repo_number_idx` ON `pull_requests` (`repo_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_github_id_idx` ON `pull_requests` (`github_id`);--> statement-breakpoint
CREATE INDEX `pull_requests_repo_id_merged_at_idx` ON `pull_requests` (`repo_id`,`merged_at`);--> statement-breakpoint
CREATE INDEX `pull_requests_author_id_idx` ON `pull_requests` (`author_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name_idx` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`reviewer_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_comments_github_id_idx` ON `review_comments` (`github_id`);--> statement-breakpoint
CREATE INDEX `review_comments_pr_id_idx` ON `review_comments` (`pr_id`);--> statement-breakpoint
CREATE INDEX `review_comments_reviewer_id_idx` ON `review_comments` (`reviewer_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` integer NOT NULL,
	`pr_id` integer NOT NULL,
	`reviewer_id` integer NOT NULL,
	`state` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`body_len` integer NOT NULL,
	`comment_count` integer NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_state_check" CHECK("reviews"."state" in ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_github_id_idx` ON `reviews` (`github_id`);--> statement-breakpoint
CREATE INDEX `reviews_pr_id_idx` ON `reviews` (`pr_id`);--> statement-breakpoint
CREATE INDEX `reviews_reviewer_id_idx` ON `reviews` (`reviewer_id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`since` integer NOT NULL,
	`until` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`pr_count` integer,
	`status` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sync_runs_status_check" CHECK("sync_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `sync_runs_repo_id_idx` ON `sync_runs` (`repo_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` integer NOT NULL,
	`login` text NOT NULL,
	`is_bot` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_idx` ON `users` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_idx` ON `users` (`login`);