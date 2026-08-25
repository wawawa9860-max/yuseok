-- =====================================================================
-- 0006 파일 Storage 구조 + 문서 Revision (수량산출서 / 작업도면)
-- Master Prompt §3(File Storage), §12, §38, §53-10
--  * 파일 실체는 스토리지에, 메타데이터/권한은 DB에 둔다(벤더 비종속, §3).
--  * 영수증 등 본사전용 파일은 visibility=HEAD_OFFICE_ONLY 로 DB에서 차단한다.
-- =====================================================================

CREATE TABLE core.stored_file (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid REFERENCES core.site(id) ON DELETE CASCADE,
  storage_backend text NOT NULL DEFAULT 'LOCAL' CHECK (storage_backend IN ('LOCAL','S3','GCS','AZURE')),
  storage_key     text NOT NULL,                -- 예: site/{site_id}/receipt/2026/08/{uuid}.jpg
  original_name   text NOT NULL,
  mime_type       text NOT NULL,
  byte_size       bigint NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 text,
  category        text NOT NULL CHECK (category IN
                    ('QUANTITY_SHEET','WORK_DRAWING','CONTRACT','FIELD_PHOTO',
                     'RECEIPT','DELIVERY_NOTE','VOICE_MEMO','REPORT','OTHER')),
  visibility      text NOT NULL DEFAULT 'SITE'
                    CHECK (visibility IN ('SITE','HEAD_OFFICE_ONLY','SHARED_EXTERNAL')),
  uploaded_by     uuid REFERENCES core.app_user(id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (storage_backend, storage_key)
);
COMMENT ON COLUMN core.stored_file.visibility IS
  'SITE=현장+본사 / HEAD_OFFICE_ONLY=본사전용(영수증·거래명세) / SHARED_EXTERNAL=계약상대방 공유승인';

CREATE INDEX ix_stored_file_site ON core.stored_file(site_id, category, uploaded_at DESC);

-- 영수증 카테고리는 항상 본사전용으로 강제한다 (§29).
CREATE OR REPLACE FUNCTION core.trg_file_visibility_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category IN ('RECEIPT') AND NEW.visibility <> 'HEAD_OFFICE_ONLY' THEN
    NEW.visibility := 'HEAD_OFFICE_ONLY';
  END IF;
  IF NEW.category IN ('RECEIPT') AND NEW.visibility = 'SHARED_EXTERNAL' THEN
    RAISE EXCEPTION '영수증은 계약상대방에게 공유할 수 없습니다.' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_file_visibility BEFORE INSERT OR UPDATE ON core.stored_file
  FOR EACH ROW EXECUTE FUNCTION core.trg_file_visibility_guard();

-- ---------------------------------------------------------------------
-- 문서 + Revision : 수량산출서/작업도면도 revision 을 가진다 (§38)
-- ---------------------------------------------------------------------
CREATE TABLE core.document (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  doc_type         text NOT NULL CHECK (doc_type IN ('QUANTITY_SHEET','WORK_DRAWING','CONTRACT','OTHER')),
  title            text NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_by       uuid REFERENCES core.app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, doc_type, title)
);
CREATE TRIGGER trg_document_touch BEFORE UPDATE ON core.document
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE core.document_revision (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES core.document(id) ON DELETE CASCADE,
  revision_no    integer NOT NULL CHECK (revision_no >= 0),
  file_id        uuid REFERENCES core.stored_file(id),
  effective_date date,
  note           text,
  approved_by    uuid REFERENCES core.app_user(id),
  approved_at    timestamptz,
  is_current     boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_no)
);
CREATE UNIQUE INDEX ux_document_revision_current ON core.document_revision(document_id) WHERE is_current;

-- RLS
ALTER TABLE core.stored_file        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.document           ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.document_revision  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.stored_file        FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.document           FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.document_revision  FORCE  ROW LEVEL SECURITY;

-- 본사전용 파일은 본사만 행 자체를 볼 수 있다.
CREATE POLICY p_file_read ON core.stored_file FOR SELECT
  USING (app.has_site_access(site_id)
         AND (visibility <> 'HEAD_OFFICE_ONLY' OR app.is_head_office())
         AND deleted_at IS NULL);
CREATE POLICY p_file_insert ON core.stored_file FOR INSERT
  WITH CHECK (app.has_site_access(site_id));
CREATE POLICY p_file_admin ON core.stored_file FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_doc_read  ON core.document FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_doc_admin ON core.document FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_docrev_read ON core.document_revision FOR SELECT
  USING (EXISTS (SELECT 1 FROM core.document d
                  WHERE d.id = document_id AND app.has_site_access(d.site_id)));
CREATE POLICY p_docrev_admin ON core.document_revision FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

GRANT SELECT, INSERT ON core.stored_file TO rfcip_field_manager;
GRANT SELECT ON core.document, core.document_revision TO rfcip_field_manager;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON core.stored_file, core.document, core.document_revision TO rfcip_head_office;
