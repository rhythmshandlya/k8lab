CREATE TABLE "problem_drafts" (
	"user_id" text NOT NULL,
	"level_slug" text NOT NULL,
	"content_version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "problem_drafts_user_id_level_slug_content_version_pk" PRIMARY KEY("user_id","level_slug","content_version")
);
--> statement-breakpoint
ALTER TABLE "problem_drafts" ADD CONSTRAINT "problem_drafts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;