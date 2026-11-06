BEGIN;
CREATE TABLE kristine.personnel_tracking_runs (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL UNIQUE,
 UNIQUE(company_id,source_instance_id,import_run_id),FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.import_runs(company_id,source_instance_id,id));
CREATE TABLE kristine.personnel_tracking_files (
 company_id uuid NOT NULL,source_instance_id uuid NOT NULL,import_run_id uuid NOT NULL,source_version_id uuid NOT NULL,source_path text NOT NULL,
 PRIMARY KEY(import_run_id,source_path),UNIQUE(company_id,source_version_id,import_run_id),
 FOREIGN KEY(company_id,source_instance_id,import_run_id) REFERENCES kristine.personnel_tracking_runs(company_id,source_instance_id,import_run_id),
 FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE FUNCTION kristine.guard_personnel_tracking_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.company_id=v.company_id AND s.id=v.source_record_id
 WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type='json_file_snapshot' AND s.external_id=NEW.source_path AND s.source_instance_id=NEW.source_instance_id)
 THEN RAISE EXCEPTION 'Personnel/tracking source mismatch';END IF;RETURN NEW;
END $$;
CREATE TRIGGER personnel_tracking_source_guard BEFORE INSERT ON kristine.personnel_tracking_files FOR EACH ROW EXECUTE FUNCTION kristine.guard_personnel_tracking_source();
CREATE FUNCTION kristine.strict_source_boolean(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN IF v IS NULL OR v='null'::jsonb THEN RETURN NULL;END IF;
 IF jsonb_typeof(v)<>'boolean' THEN RAISE EXCEPTION 'Source flag must remain boolean';END IF;RETURN v::text::boolean;END $$;
CREATE VIEW kristine.latest_personnel_tracking_runs AS
 SELECT DISTINCT ON(r.company_id,r.source_instance_id) r.company_id,r.source_instance_id,r.import_run_id
 FROM kristine.personnel_tracking_runs r JOIN kristine.import_runs i ON i.id=r.import_run_id WHERE i.status='validated' ORDER BY r.company_id,r.source_instance_id,r.sequence DESC;
CREATE VIEW kristine.latest_personnel_tracking_files AS
 SELECT f.* FROM kristine.latest_personnel_tracking_runs l JOIN kristine.personnel_tracking_files f ON f.company_id=l.company_id AND f.source_instance_id=l.source_instance_id AND f.import_run_id=l.import_run_id;
CREATE TABLE kristine.imported_employee_profiles_entries (company_id uuid NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),raw_payload jsonb NOT NULL,legacy_id text,name_original text,nickname_original text,personnel_number_original text,short_code_original text,phone_original text,role_original text,team_original text,worktime_model_id_original text,gross_monthly_salary_original text,employment_percent_original text,employment_start_original text,employment_end_original text,birth_date_original text,driving_license_last_check_original text,driving_license_front_image text,driving_license_back_image text,passport_page1_image text,passport_page2_image text,passport_expiry_original text,standard_start_original text,standard_end_original text,standard_break_minutes_original text,updated_at_original text,foreman_original boolean,can_manage_team_original boolean,active_original boolean,specialties jsonb,clothing_sizes jsonb,clothing_issues jsonb,PRIMARY KEY(source_version_id,position),FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE VIEW kristine.latest_imported_employee_profiles AS SELECT e.*,f.source_instance_id,f.source_path,f.import_run_id AS reconciliation_run_id FROM kristine.latest_personnel_tracking_files f JOIN kristine.imported_employee_profiles_entries e ON e.company_id=f.company_id AND e.source_version_id=f.source_version_id;
CREATE TABLE kristine.imported_vehicle_rides_entries (company_id uuid NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),raw_payload jsonb NOT NULL,legacy_id text,legacy_vehicle_id text,started_at_original text,closed_at_original text,source_original text,driver_assigned_at_original text,date_original text,created_at_original text,odometer_start_original text,odometer_end_original text,distance_meters_original text,distance_km_original text,buzzer_due_at_original text,buzzer_changed_at_original text,buzzer_reason_original text,unresolved_driver_original boolean,buzzer_wanted_original boolean,driver_original jsonb,start_position jsonb,last_position jsonb,PRIMARY KEY(source_version_id,position),FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE VIEW kristine.latest_imported_vehicle_rides AS SELECT e.*,f.source_instance_id,f.source_path,f.import_run_id AS reconciliation_run_id FROM kristine.latest_personnel_tracking_files f JOIN kristine.imported_vehicle_rides_entries e ON e.company_id=f.company_id AND e.source_version_id=f.source_version_id;
CREATE TABLE kristine.imported_vehicle_positions_entries (company_id uuid NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),raw_payload jsonb NOT NULL,legacy_vehicle_id text,traccar_position_id_original text,device_id_original text,at_original text,lat_original text,lng_original text,speed_knots_original text,course_original text,address_original text,odometer_original text,battery_level_original text,ignition_original boolean,can_original jsonb,attributes_original jsonb,PRIMARY KEY(source_version_id,position),FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE VIEW kristine.latest_imported_vehicle_positions AS SELECT e.*,f.source_instance_id,f.source_path,f.import_run_id AS reconciliation_run_id FROM kristine.latest_personnel_tracking_files f JOIN kristine.imported_vehicle_positions_entries e ON e.company_id=f.company_id AND e.source_version_id=f.source_version_id;
CREATE TABLE kristine.imported_gps_rows_entries (company_id uuid NOT NULL,source_version_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),raw_payload jsonb NOT NULL,legacy_id text,date_original text,driver_name_original text,driver_key_original text,gps_employee_id_original text,vehicle_name_original text,vehicle_number_original text,license_plate_original text,start_location_original text,stop_location_original text,start_time_original text,arrival_time_original text,departure_time_original text,travel_seconds_original text,stay_seconds_original text,idle_seconds_original text,distance_km_original text,odometer_start_original text,odometer_end_original text,start_lat_original text,start_lng_original text,stop_lat_original text,stop_lng_original text,fuel_type_original text,private_marked_at_original text,assigned_employee_id_original text,assigned_employee_name_original text,assignment_updated_at_original text,is_private_original boolean,passengers_original jsonb,change_history jsonb,PRIMARY KEY(source_version_id,position),FOREIGN KEY(company_id,source_version_id) REFERENCES kristine.source_record_versions(company_id,id));
CREATE VIEW kristine.latest_imported_gps_rows AS SELECT e.*,f.source_instance_id,f.source_path,f.import_run_id AS reconciliation_run_id FROM kristine.latest_personnel_tracking_files f JOIN kristine.imported_gps_rows_entries e ON e.company_id=f.company_id AND e.source_version_id=f.source_version_id;
CREATE VIEW kristine.current_imported_gps_rows AS SELECT * FROM kristine.latest_imported_gps_rows WHERE source_path='_kristine/gps-imports/latest.json';
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.personnel_tracking_runs FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.personnel_tracking_runs FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.personnel_tracking_files FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.personnel_tracking_files FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.imported_employee_profiles_entries FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.imported_employee_profiles_entries FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.imported_vehicle_rides_entries FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.imported_vehicle_rides_entries FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.imported_vehicle_positions_entries FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.imported_vehicle_positions_entries FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON kristine.imported_gps_rows_entries FOR EACH ROW EXECUTE FUNCTION kristine.reject_history_change();CREATE TRIGGER no_truncate BEFORE TRUNCATE ON kristine.imported_gps_rows_entries FOR EACH STATEMENT EXECUTE FUNCTION kristine.reject_history_change();
CREATE FUNCTION kristine.guard_personnel_tracking_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text;
BEGIN
 SELECT s.external_id INTO p FROM kristine.source_record_versions v JOIN kristine.source_records s ON s.company_id=v.company_id AND s.id=v.source_record_id WHERE v.company_id=NEW.company_id AND v.id=NEW.source_version_id AND s.entity_type='json_file_snapshot';
 IF p IS NULL OR (TG_TABLE_NAME='imported_employee_profiles_entries' AND p<>'_system/employees.json')
 OR (TG_TABLE_NAME='imported_vehicle_rides_entries' AND p NOT IN ('_kristine/vehicle-tracking/rides.json','_kristine/vehicle-tracking/sessions.json'))
 OR (TG_TABLE_NAME='imported_vehicle_positions_entries' AND p NOT LIKE '_kristine/vehicle-tracking/positions/%.jsonl')
 OR (TG_TABLE_NAME='imported_gps_rows_entries' AND p NOT LIKE '_kristine/gps-imports/%.json')
 THEN RAISE EXCEPTION 'Personnel/tracking entry source mismatch';END IF;
 IF jsonb_typeof(NEW.raw_payload)<>'object' THEN RAISE EXCEPTION 'Personnel/tracking row must be object';END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['imported_employee_profiles_entries','imported_vehicle_rides_entries','imported_vehicle_positions_entries','imported_gps_rows_entries'] LOOP
 EXECUTE format('CREATE TRIGGER source_guard BEFORE INSERT ON kristine.%I FOR EACH ROW EXECUTE FUNCTION kristine.guard_personnel_tracking_entry()',t);
 END LOOP;END $$;
COMMIT;
