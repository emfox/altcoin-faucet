# Provision the application database user (runs as root on first boot).
mysql=(mysql -uroot -p"${MYSQL_ROOT_PASSWORD}")

"${mysql[@]}" <<SQL
CREATE USER IF NOT EXISTS '${MYSQL_FAUCET_USER}'@'%' IDENTIFIED BY '${MYSQL_FAUCET_PASSWORD}';
GRANT ALL PRIVILEGES ON faucet.* TO '${MYSQL_FAUCET_USER}'@'%';
FLUSH PRIVILEGES;
SQL
