# Seed round #1 with the configured single payout (runs as root on first boot).
mysql=(mysql -uroot -p"${MYSQL_ROOT_PASSWORD}")

"${mysql[@]}" faucet <<SQL
INSERT INTO rounds (round_no, singlepay)
SELECT 1, '${INITIAL_SINGLEPAY}'
WHERE NOT EXISTS (SELECT 1 FROM rounds);
SQL
