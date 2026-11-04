-- Náhrada rozšírenia pg_net pre testy: požiadavky sa len zapíšu do net.calls
create schema if not exists net;
create table if not exists net._http_response (id bigint primary key, status_code int, content text, error_msg text, created timestamptz default now());
create table if not exists net.calls (id bigserial primary key, url text, body jsonb);
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
language sql as $$ insert into net.calls (url, body) values (url, body) returning id $$;
