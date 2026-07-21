-- Scoped rollback for Prompt 7H only; never deletes reservations or historical evidence.
DROP TABLE `reservation_decisions`;
DROP TABLE `reservation_management_scopes`;
DROP TABLE `application_account_roles`;
DROP TABLE `application_roles`;
