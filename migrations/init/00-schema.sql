-- Altcoin Faucet schema (coin-agnostic)
-- MySQL 8, utf8mb4
--
-- NOTE: a copy of this file lives at migrations/init/00-schema.sql and is run
-- automatically by the MySQL image on a fresh data directory. If you edit
-- this file, keep the copy in sync (cp migrations/schema.sql
-- migrations/init/00-schema.sql).
--
-- Money convention: `rounds.singlepay` stores an amount in whole coins
-- (DECIMAL(20,8)), while `payouts.amount_dvc` stores the total paid out in
-- *smallest units* (sat) as an integer string — safe across coins with
-- different decimal precision (COIN_DECIMALS).

CREATE DATABASE IF NOT EXISTS faucet CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE faucet;

-- One row per round. An "open" round collects claims until ROUND_SIZE is
-- reached, at which point the settlement engine batch-pays it and opens the
-- next round. singlepay is the per-claim payout of that round.
CREATE TABLE IF NOT EXISTS rounds (
    id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    round_no    INT UNSIGNED      NOT NULL,
    singlepay   DECIMAL(20, 8)    NOT NULL,
    status      ENUM('open', 'paid') NOT NULL DEFAULT 'open',
    settled_at  DATETIME(3)       NULL DEFAULT NULL,
    created_at  DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_rounds_no (round_no)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- One row per successful claim. A claim is unique per (round, ip) and per
-- (round, address) — enforced by the database, not by application logic.
CREATE TABLE IF NOT EXISTS claims (
    id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    round_id    BIGINT UNSIGNED   NOT NULL,
    address     VARCHAR(64)       NOT NULL,
    ip          VARCHAR(64)       NOT NULL,
    created_at  DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_claims_round_ip   (round_id, ip),
    UNIQUE KEY uq_claims_round_addr (round_id, address),
    KEY ix_claims_round (round_id),
    CONSTRAINT fk_claims_round FOREIGN KEY (round_id) REFERENCES rounds (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Exactly one row per settled round, recorded for audit + total payout stats.
CREATE TABLE IF NOT EXISTS payouts (
    id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    round_id    BIGINT UNSIGNED   NOT NULL,
    txid        CHAR(64)          NOT NULL,
    amount_dvc  DECIMAL(20, 8)    NOT NULL,
    payee_count INT UNSIGNED      NOT NULL,
    created_at  DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_payouts_round (round_id),
    CONSTRAINT fk_payouts_round FOREIGN KEY (round_id) REFERENCES rounds (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
