-- ==========================================
-- Migration 000: Initial schema
-- ==========================================
-- This was never captured as a migration when the app was first built -- the 6 core
-- tables (departments, users, toolboxes, drawers, tools, audit_logs) plus tool_transfers
-- were set up ad hoc against the dev database. This file is a schema-only dump of that
-- live database (structure only, no rows), generated retroactively so a fresh deployment
-- (e.g. the Raspberry Pi) has a real, single source of truth to build from instead of
-- relying on someone's memory of how the dev DB was originally set up.
--
-- Run this FIRST on a brand-new empty database, then run 001_beta_feedback.sql after it
-- (that one only ALTERs/CREATEs what it added on top of this schema).
--
-- Usage: docker exec -i <db-container> psql -U tooladmin -d tooltracker -f - < migrations/000_initial_schema.sql

--
-- PostgreSQL database dump
--

\restrict wJHkb6KJeazfTx3xy9uCAtpzgasLqzbcCqMUwr5MjLrECyUDYSnQekJhjgKegiy

-- Dumped from database version 15.18 (Debian 15.18-1.pgdg13+1)
-- Dumped by pg_dump version 15.18 (Debian 15.18-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: prevent_log_tampering(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_log_tampering() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Editing or deleting audit logs is strictly prohibited.';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    log_id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    user_id integer,
    action character varying(50) NOT NULL,
    tool_id integer,
    box_id integer,
    notes text
);


--
-- Name: audit_logs_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_log_id_seq OWNED BY public.audit_logs.log_id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    dept_id integer NOT NULL,
    name character varying(100) NOT NULL,
    location character varying(100),
    prefix_code character varying(10)
);


--
-- Name: departments_dept_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.departments_dept_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: departments_dept_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.departments_dept_id_seq OWNED BY public.departments.dept_id;


--
-- Name: drawers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drawers (
    drawer_id integer NOT NULL,
    box_id integer,
    name character varying(100) NOT NULL,
    photo_url text,
    image_path character varying(255)
);


--
-- Name: drawers_drawer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drawers_drawer_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drawers_drawer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drawers_drawer_id_seq OWNED BY public.drawers.drawer_id;


--
-- Name: tool_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_transfers (
    transfer_id integer NOT NULL,
    tool_id integer NOT NULL,
    home_dept_id integer NOT NULL,
    qa_dept_id integer NOT NULL,
    origin_drawer_id integer,
    status text DEFAULT 'AWAITING_QA_ACCEPT'::text NOT NULL,
    initiated_by_user_id integer NOT NULL,
    initiated_at timestamp without time zone DEFAULT now() NOT NULL,
    qa_accepted_by_user_id integer,
    qa_accepted_at timestamp without time zone,
    cal_completed_by_user_id integer,
    cal_completed_at timestamp without time zone,
    home_accepted_by_user_id integer,
    home_accepted_at timestamp without time zone,
    notes text,
    cancelled_reason text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: tool_transfers_transfer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tool_transfers_transfer_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tool_transfers_transfer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tool_transfers_transfer_id_seq OWNED BY public.tool_transfers.transfer_id;


--
-- Name: toolboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.toolboxes (
    box_id integer NOT NULL,
    qr_code character varying(100),
    name character varying(100) NOT NULL,
    dept_id integer,
    location character varying(100),
    photo_url text,
    is_locked boolean DEFAULT true,
    image_path character varying(255)
);


--
-- Name: toolboxes_box_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.toolboxes_box_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: toolboxes_box_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.toolboxes_box_id_seq OWNED BY public.toolboxes.box_id;


--
-- Name: tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tools (
    tool_id integer NOT NULL,
    qr_code character varying(100) NOT NULL,
    box_id integer,
    name character varying(100) NOT NULL,
    part_number character varying(100),
    photo_url text,
    status character varying(20) DEFAULT 'In'::character varying,
    status_reason text,
    drawer_id integer,
    replaced_by_id integer,
    image_path character varying(255),
    is_calibrated boolean DEFAULT false,
    last_cal_date date,
    cal_due_date date,
    description text,
    replacement_url character varying(255),
    serial_number text
);


--
-- Name: tools_tool_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tools_tool_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tools_tool_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tools_tool_id_seq OWNED BY public.tools.tool_id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id integer NOT NULL,
    badge_id character varying(50) NOT NULL,
    full_name character varying(100) NOT NULL,
    dept_id integer,
    photo_url text,
    role character varying(20) DEFAULT 'technician'::character varying,
    is_active boolean DEFAULT true,
    pin character varying(20) DEFAULT '1234'::character varying,
    username character varying(50),
    email character varying(100),
    image_path character varying(255)
);


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_user_id_seq OWNED BY public.users.user_id;


--
-- Name: audit_logs log_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN log_id SET DEFAULT nextval('public.audit_logs_log_id_seq'::regclass);


--
-- Name: departments dept_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments ALTER COLUMN dept_id SET DEFAULT nextval('public.departments_dept_id_seq'::regclass);


--
-- Name: drawers drawer_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drawers ALTER COLUMN drawer_id SET DEFAULT nextval('public.drawers_drawer_id_seq'::regclass);


--
-- Name: tool_transfers transfer_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers ALTER COLUMN transfer_id SET DEFAULT nextval('public.tool_transfers_transfer_id_seq'::regclass);


--
-- Name: toolboxes box_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toolboxes ALTER COLUMN box_id SET DEFAULT nextval('public.toolboxes_box_id_seq'::regclass);


--
-- Name: tools tool_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools ALTER COLUMN tool_id SET DEFAULT nextval('public.tools_tool_id_seq'::regclass);


--
-- Name: users user_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN user_id SET DEFAULT nextval('public.users_user_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (log_id);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (dept_id);


--
-- Name: drawers drawers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drawers
    ADD CONSTRAINT drawers_pkey PRIMARY KEY (drawer_id);


--
-- Name: tool_transfers tool_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_pkey PRIMARY KEY (transfer_id);


--
-- Name: toolboxes toolboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toolboxes
    ADD CONSTRAINT toolboxes_pkey PRIMARY KEY (box_id);


--
-- Name: toolboxes toolboxes_qr_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toolboxes
    ADD CONSTRAINT toolboxes_qr_code_key UNIQUE (qr_code);


--
-- Name: tools tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (tool_id);


--
-- Name: tools tools_qr_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_qr_code_key UNIQUE (qr_code);


--
-- Name: departments unique_prefix; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT unique_prefix UNIQUE (prefix_code);


--
-- Name: users users_badge_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_badge_id_key UNIQUE (badge_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_tool_transfers_home_dept; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_transfers_home_dept ON public.tool_transfers USING btree (home_dept_id, status);


--
-- Name: idx_tool_transfers_qa_dept; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_transfers_qa_dept ON public.tool_transfers USING btree (qa_dept_id, status);


--
-- Name: idx_tool_transfers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_transfers_status ON public.tool_transfers USING btree (status);


--
-- Name: idx_tool_transfers_tool_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_transfers_tool_id ON public.tool_transfers USING btree (tool_id);


--
-- Name: uq_tool_transfers_one_active_per_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tool_transfers_one_active_per_tool ON public.tool_transfers USING btree (tool_id) WHERE (status <> ALL (ARRAY['COMPLETE'::text, 'CANCELLED'::text]));


--
-- Name: audit_logs audit_logs_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_box_id_fkey FOREIGN KEY (box_id) REFERENCES public.toolboxes(box_id);


--
-- Name: audit_logs audit_logs_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(tool_id);


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id);


--
-- Name: drawers drawers_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drawers
    ADD CONSTRAINT drawers_box_id_fkey FOREIGN KEY (box_id) REFERENCES public.toolboxes(box_id) ON DELETE CASCADE;


--
-- Name: tool_transfers tool_transfers_cal_completed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_cal_completed_by_user_id_fkey FOREIGN KEY (cal_completed_by_user_id) REFERENCES public.users(user_id);


--
-- Name: tool_transfers tool_transfers_home_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_home_accepted_by_user_id_fkey FOREIGN KEY (home_accepted_by_user_id) REFERENCES public.users(user_id);


--
-- Name: tool_transfers tool_transfers_home_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_home_dept_id_fkey FOREIGN KEY (home_dept_id) REFERENCES public.departments(dept_id) ON DELETE RESTRICT;


--
-- Name: tool_transfers tool_transfers_initiated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_initiated_by_user_id_fkey FOREIGN KEY (initiated_by_user_id) REFERENCES public.users(user_id);


--
-- Name: tool_transfers tool_transfers_origin_drawer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_origin_drawer_id_fkey FOREIGN KEY (origin_drawer_id) REFERENCES public.drawers(drawer_id) ON DELETE SET NULL;


--
-- Name: tool_transfers tool_transfers_qa_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_qa_accepted_by_user_id_fkey FOREIGN KEY (qa_accepted_by_user_id) REFERENCES public.users(user_id);


--
-- Name: tool_transfers tool_transfers_qa_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_qa_dept_id_fkey FOREIGN KEY (qa_dept_id) REFERENCES public.departments(dept_id) ON DELETE RESTRICT;


--
-- Name: tool_transfers tool_transfers_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_transfers
    ADD CONSTRAINT tool_transfers_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(tool_id) ON DELETE CASCADE;


--
-- Name: toolboxes toolboxes_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.toolboxes
    ADD CONSTRAINT toolboxes_dept_id_fkey FOREIGN KEY (dept_id) REFERENCES public.departments(dept_id) ON DELETE SET NULL;


--
-- Name: tools tools_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_box_id_fkey FOREIGN KEY (box_id) REFERENCES public.toolboxes(box_id) ON DELETE SET NULL;


--
-- Name: tools tools_drawer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_drawer_id_fkey FOREIGN KEY (drawer_id) REFERENCES public.drawers(drawer_id) ON DELETE SET NULL;


--
-- Name: tools tools_replaced_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_replaced_by_id_fkey FOREIGN KEY (replaced_by_id) REFERENCES public.tools(tool_id) ON DELETE SET NULL;


--
-- Name: users users_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_dept_id_fkey FOREIGN KEY (dept_id) REFERENCES public.departments(dept_id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict wJHkb6KJeazfTx3xy9uCAtpzgasLqzbcCqMUwr5MjLrECyUDYSnQekJhjgKegiy

