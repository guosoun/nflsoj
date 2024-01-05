import * as TypeORM from "typeorm";
import Model from "./common";

@TypeORM.Entity()
export default class Video extends Model {
    @TypeORM.PrimaryGeneratedColumn()
    id: number;

    @TypeORM.Column()
    title: string;

    @TypeORM.Column({ type: 'text' })
    description: string;

    @TypeORM.Column()
    url: string;

    @TypeORM.Column()
    access_url: string;

    @TypeORM.Column({ nullable: true, type: "integer" })
    created_time: number;

    @TypeORM.Column({ type: "integer" })
    user_id: number;
    
    @TypeORM.Column()
    size: number;

    @TypeORM.Column({ nullable: true})
    problem_id: number;
}